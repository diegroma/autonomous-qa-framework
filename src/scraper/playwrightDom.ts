// src/scraper/playwrightDom.ts
import { chromium, Page } from 'playwright';
import { NavStep, DomMap } from '../types';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

// Make the timeout agnostic: read from environment variables or default to 1500ms.
const FALLBACK_TIMEOUT = process.env.FALLBACK_TIMEOUT ? parseInt(process.env.FALLBACK_TIMEOUT, 10) : 1500;

/**
 * Captures the semantic DOM of the current page.
 * Extracts only actionable and verifiable elements (data-test, buttons, inputs, links)
 * to keep the context window small for the LLM.
 */
async function snapDom(page: Page): Promise<string> {
    const lines: string[] = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-test], button, input, select, label, a, h1, h2, h3, h4, h5, [aria-label], [role="button"], [role="link"]')).map(el => {
            const tag = el.tagName.toLowerCase();
            const dt  = el.getAttribute('data-test') || '';
            const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
            const typ = el.getAttribute('type') || '';
            const name = el.getAttribute('name') || '';
            const placeholder = el.getAttribute('placeholder') || '';
            const id = el.getAttribute('id') || '';
            const cls = el.className || '';
            const forAttr = el.getAttribute('for') || '';
            const ariaLabel = el.getAttribute('aria-label') || '';
            const role = el.getAttribute('role') || '';
            const title = el.getAttribute('title') || '';
            
            // Ignore empty elements that provide no value to the AI
            if (!dt && !name && !txt && !placeholder && !ariaLabel && !title && !el.classList.contains('title')) return null;
            
            // Build a concise pseudo-HTML line
            return tag     
                + (id ? `[id="${id}"]` : '')
                + (cls ? `[class="${cls}"]` : '')
                + (dt ? `[data-test="${dt}"]` : '') 
                + (name ? `[name="${name}"]` : '') 
                + (placeholder ? `[placeholder="${placeholder}"]` : '') 
                + (ariaLabel ? `[aria-label="${ariaLabel}"]` : '')
                + (role ? `[role="${role}"]` : '')
                + (title ? `[title="${title}"]` : '')
                + (typ ? ` type="${typ}"` : '') 
                + (txt ? ` "${txt}"` : '')
                + (forAttr ? `[for="${forAttr}"]` : '');
        }).filter(Boolean) as string[]
    );
    return [...new Set(lines)].join('\n'); // Remove duplicates
}

/**
 * Executes the planned navigation flow to reach the target state, 
 * capturing the DOM at each step. Implements Fail-Fast to avoid garbage data.
 */
export async function scrape(flow: NavStep[]): Promise<DomMap> {
    console.log('\n🕵️‍♂️ Validating navigation flow and extracting live DOM...');
    const browser = await chromium.launch({ headless: true });
    // Block known ad/tracking domains to speed up loading and reduce noise in the DOM. This is crucial for the AI to focus on relevant elements.
    const context = await browser.newContext();
    await context.route('**/*', route => {
        const url = route.request().url();
        if (/googlesyndication|doubleclick|adsbygoogle|googletagmanager|adthrive|amazon-adsystem/.test(url)) {
            route.abort();
        } else {
            route.continue();
        }
    });
    const page = await context.newPage();
    const out: DomMap = {};

    for (const step of flow) {
        console.log(`   -> [${step.page}] Executing: ${step.action} ${step.selector || step.url || ''}`);
        try {
            if (step.action === 'goto') {
                await page.goto(step.url!, { waitUntil: 'networkidle', timeout: 15000 }); 
            } else if (step.action === 'click' || step.action === 'fill') {
                
                // SMART FALLBACK LOOP: Split the comma-separated selectors provided by the AI
                const selectors = step.selector!.split(',').map(s => s.trim());
                let actionSuccess = false;
                let lastError: any = null;

                for (let sel of selectors) {
                    if (!sel) continue;

                    // THE SILVER BULLET: Prevent Playwright substring bleeding.
                    // Example: 'text=Cart' wrongly matches 'Add to Cart'. We force it to exact match 'text="Cart"'.
                    if (sel.startsWith('text=') && !sel.includes('"') && !sel.includes("'") && !sel.includes('/')) {
                        sel = `text="${sel.substring(5)}"`;
                    }

                    try {
                        // Use the FALLBACK_TIMEOUT variable
                        if (step.action === 'click') {
                            await page.evaluate(() => {
                                document.querySelectorAll('[id*="google_ads"], [id*="ad-"], [class*="adsbygoogle"], [id*="AdThrive"], [id*="overlay"]')
                                .forEach(el => (el as HTMLElement).style.display = 'none');
                    });
                            await page.locator(sel).first().click({ timeout: FALLBACK_TIMEOUT, force: true });
                            await page.waitForLoadState('domcontentloaded'); 
                        } else {
                            await page.locator(sel).first().fill(step.value ?? '', { timeout: FALLBACK_TIMEOUT }); 
                        }
                        
                        actionSuccess = true;
                        // If successful, log it and break the fallback loop
                        if (selectors.length > 1) {
                            console.log(`      ✨ Fallback success with: ${sel}`);
                        }
                        break; 
                    } catch (err: any) {
                        lastError = err;
                        // Silently continue to the next selector
                    }
                }

                // If ALL fallbacks failed, throw the last error to trigger the FATAL ERROR abort
                if (!actionSuccess) {
                    throw new Error(`All fallback selectors failed. Last error: ${lastError?.message?.split('\n')[0]}`);
                }
            }
        } catch (e: any) {
            // Fail-fast mechanism: If navigation fails, abort completely
            // to prevent the AI from generating code based on an incorrect screen.
            console.error(`\n❌ FATAL ERROR: Scraper could not advance on [${step.page}].`);
            console.error(`   Failed selector: ${step.selector}. Details: ${e.message}`);
            console.error(`   >> Aborting to prevent extracting a false DOM and generating broken code.`);
            await browser.close();
            process.exit(1);
        }

        // Snapshot the current screen's DOM
        out[step.page] = await snapDom(page);
        console.log(`      ✓ Captured ${out[step.page].split('\n').filter(Boolean).length} locators`);
        fs.writeFileSync('dom_debug.json', JSON.stringify(out, null, 2));
    }
    
    await browser.close();
    return out;
}