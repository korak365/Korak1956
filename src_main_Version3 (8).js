// Code-Base Crawler Actor
// Scrapes public GitHub and GitLab repositories for specific libraries/files to collect training data.
// Uses CheerioCrawler (HTTP-based). Does NOT run page JS and performs best-effort extraction.

import { Actor } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';

// Initialize the Actor environment
await Actor.init();

// Read input
const {
    startUrls = [
        'https://github.com/search?q=express+middleware&type=Repositories',
        'https://gitlab.com/search?search=express'
    ],
    repoQuery = '',
    maxRequestsPerCrawl = 500,
    minStars = 50,
    languages = ['JavaScript', 'Python'],
    includeForks = false,
    scanFiles = ['package.json', 'requirements.txt', 'pyproject.toml', 'setup.py', 'Dockerfile'],
    siteAllowList = ['github.com', 'gitlab.com']
} = (await Actor.getInput()) ?? {};

// Create proxy configuration (recommended on Apify)
const proxyConfiguration = await Actor.createProxyConfiguration();

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl,
    async requestHandler({ request, $, enqueueLinks, log }) {
        const url = request.loadedUrl;
        log.info(`Processing: ${url}`);

        try {
            // If on a search/listing page, enqueue repository links
            if (url.includes('github.com/search') || url.includes('gitlab.com/search')) {
                // GitHub: repo links have href like /owner/repo
                $('a[href*="/"][href*="/"]').each((i, el) => {
                    const href = $(el).attr('href');
                    if (!href) return;
                    // Heuristic: skip user/profile links and focus on /owner/repo pattern
                    const parts = href.split('/').filter(Boolean);
                    if (parts.length >= 2) {
                        const possibleRepo = `/${parts[0]}/${parts[1]}`;
                        if (href.startsWith('/' + parts[0] + '/' + parts[1])) {
                            const full = href.startsWith('http') ? href : new URL(href, url).href;
                            // Enqueue repository page
                            enqueueLinks({ urls: [full] }).catch(() => {});
                        }
                    }
                });

                // Also follow pagination links
                enqueueLinks({
                    globs: ['**?p=*', '**&p=*', '**/page/*'],
                }).catch(() => {});
                return;
            }

            // If on a repository page (GitHub or GitLab), extract metadata and scan file listing
            if (url.includes('github.com/') || url.includes('gitlab.com/')) {
                // Best-effort detect repo name owner/repo from URL
                const matched = url.match(/(?:github\.com|gitlab\.com)\/([^\/]+\/[^\/]+)(?:\/|$)/);
                if (!matched) return;

                const repoName = matched[1];
                const host = new URL(url).hostname;

                // Skip common non-repo pages (issues, pulls, merge_requests)
                if (/\/(issues|pull|pulls|merge_requests|-/).test(url) && !/\/$/.test(url)) {
                    // continue but prefer the root repo page
                }

                // Attempt to get repo metadata
                let description = '';
                let stars = null;
                let forks = null;
                let language = '';

                if (host.includes('github.com')) {
                    description = $('meta[name="description"]').attr('content') || $('p.f4.mt-3').text().trim() || '';
                    const starsText = $('a[href$="/stargazers"]').first().text().trim().replace(/,/g, '');
                    const forksText = $('a[href$="/network/members"]').first().text().trim().replace(/,/g, '');
                    stars = parseInt((starsText.match(/\d+/) || [null])[0]) || null;
                    forks = parseInt((forksText.match(/\d+/) || [null])[0]) || null;
                    language = $('li.d-inline .language-color + span, [itemprop="programmingLanguage"]').first().text().trim() || language;
                } else if (host.includes('gitlab.com')) {
                    description = $('meta[property="og:description"]').attr('content') || $('p.description').text().trim() || '';
                    const starsText = $('a[data-qa-selector="project_star_count"]').first().text().trim().replace(/,/g, '');
                    stars = parseInt((starsText.match(/\d+/) || [null])[0]) || null;
                    // GitLab forks detection best-effort
                    forks = null;
                    language = $('[data-testid="language-name"]').first().text().trim() || language;
                }

                // Filter by stars and forks and languages if provided
                if (minStars && stars !== null && stars < minStars) {
                    log.info('Skipping repo due to star filter', { repoName, stars, minStars });
                    return;
                }

                if (languages && languages.length > 0 && language) {
                    const okLang = languages.some(l => language.toLowerCase().includes(l.toLowerCase()));
                    if (!okLang) {
                        log.info('Skipping repo due to language filter', { repoName, language });
                        return;
                    }
                }

                // Detect fork information - best-effort
                const forkBadge = $('[rel="author"]').text().toLowerCase().includes('fork') || $('span.Label--secondary').text().toLowerCase().includes('fork');
                if (!includeForks && forkBadge) {
                    log.info('Skipping forked repository', { repoName });
                    return;
                }

                // Collect file links to scan for scanFiles list
                const matchedFiles = [];
                const matchedDependencies = [];

                // Common file listing patterns: GitHub file list anchors, GitLab similar
                $('a').each((i, el) => {
                    const href = $(el).attr('href') || '';
                    const text = $(el).text() || '';
                    for (const fname of scanFiles) {
                        if (href.endsWith('/' + fname) || text.trim() === fname) {
                            const fileUrl = href.startsWith('http') ? href : new URL(href, url).href;
                            matchedFiles.push({ name: fname, url: fileUrl });
                        }
                    }
                });

                // If files were not found in listing, try common raw file URLs heuristics
                if (matchedFiles.length === 0) {
                    for (const fname of scanFiles) {
                        try {
                            // Try raw URLs for GitHub
                            if (host.includes('github.com')) {
                                const raw = `https://raw.githubusercontent.com/${repoName}/HEAD/${fname}`;
                                matchedFiles.push({ name: fname, url: raw, raw: true });
                            } else if (host.includes('gitlab.com')) {
                                const raw = `https://gitlab.com/${repoName}/-/raw/HEAD/${fname}`;
                                matchedFiles.push({ name: fname, url: raw, raw: true });
                            }
                        } catch (e) {}
                    }
                }

                // Fetch matched files and attempt to extract dependencies (best-effort)
                for (const mf of matchedFiles) {
                    try {
                        const fetchRes = await crawler.requestAsBrowser({ url: mf.url, method: 'GET', headers: { Accept: 'text/plain' } });
                        if (fetchRes && fetchRes.body) {
                            const body = fetchRes.body.toString('utf8');
                            // Parse package.json
                            if (mf.name.toLowerCase().endsWith('package.json')) {
                                try {
                                    const pkg = JSON.parse(body);
                                    const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
                                    matchedDependencies.push(...Object.keys(deps));
                                } catch (e) {
                                    // ignore JSON parse errors
                                }
                            } else if (mf.name.toLowerCase().includes('requirements')) {
                                const lines = body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                                matchedDependencies.push(...lines.map(l => l.split(/[=<>~!]/)[0]));
                            } else if (mf.name.toLowerCase().includes('pyproject')) {
                                // best-effort parse simple [tool.poetry.dependencies] or project.dependencies
                                const lines = body.split(/\r?\n/);
                                for (const line of lines) {
                                    const m = line.match(/^[A-Za-z0-9_.-]+/);
                                    if (m) matchedDependencies.push(m[0]);
                                }
                            }
                        }
                    } catch (err) {
                        // ignore fetch errors
                    }
                }

                // Deduplicate matchedDependencies
                const uniqueDeps = Array.from(new Set(matchedDependencies.filter(Boolean))).slice(0, 200);

                // Save to dataset
                await Dataset.pushData({
                    repoName,
                    repoUrl: `https://${host}/${repoName}`,
                    description: description || '',
                    stars: stars || 0,
                    forks: forks || 0,
                    language: language || '',
                    matchedFiles: matchedFiles.map(f => f.name ? f.name : f),
                    matchedDependencies: uniqueDeps,
                    host,
                    timestamp: new Date().toISOString()
                });

                log.info('Saved repository', { repoName, stars, matchedFiles: matchedFiles.length });
            }
        } catch (err) {
            log.warning('Error processing page', { url, error: err.message });
        }
    },
    // Respect robots and polite crawling by default - Crawlee supports this via options; keep defaults here.
});

// Run the crawler
await crawler.run(startUrls);
console.log('Actor finished - repositories dataset ready.');
await Actor.exit();