// src/healer/autoHealer.ts
import fs from 'fs';
import { PomDef, DomMap } from '../types';
import { ai } from '../ai/groqClient';
import { saveCodeBlocks } from '../utils/fileSystem';

const TEST_TIMEOUT = parseInt(process.env.TEST_TIMEOUT || '60000');

/**
 * ── AUTO-HEALING ENGINE ──
 * Focuses exclusively on running tests and fixing errors.
 * Returns true if the tests eventually passed, false if they failed.
 */
export async function heal(ctx: string, initial: string, poms: PomDef[], dom: DomMap, specFile: string, specPath: string): Promise<boolean> {
    const { execSync } = await import('child_process');
    const N = poms.length + 1;

    const run = () => { 
        try { 
            execSync(`npx playwright test ${specPath} --reporter=line`, { 
                encoding: 'utf-8',
                timeout: TEST_TIMEOUT // Test timeout to prevent hanging on infinite loops or long waits
        });
            return { ok: true, out: '' }; 
        } catch (e: any) { 
            return { ok: false, out: (e.stdout ?? e.message ?? '') as string }; 
        } 
    };

    const domCtx = poms.map(p => `=== ${p.className} ===\n${p.domPages.map(pg => `[${pg}]:\n${dom[pg] || ''}`).join('\n')}`).join('\n\n');

    // Attempt to save initial code
    if (!saveCodeBlocks(initial, poms, specPath)) { 
        console.error('Could not extract code blocks.'); 
        return false; 
    }
    
    console.log('\nFiles saved:');
    poms.forEach(p => console.log(`   pages/${p.className}.ts`));
    console.log(`   tests/${specFile}`);

    for (let i = 1; i <= 5; i++) {
        console.log(`\nRunning tests — attempt ${i}/5...`);
        const { ok, out } = run();
        
        if (ok) { 
            console.log('\n✅ All tests passed!'); 
            return true; 
        }
        
        console.log('Failed.');
        // Clean console output for the user
        const cleanOut = out.split('\n').filter(l => !l.includes('npm warn')).join('\n').trim().slice(0, 400);
        console.log(`   [Log]: ${cleanOut}...\n`);
        
        if (i === 5) break;

        // Truncate the raw error to prevent AI context overflow (max 2000 chars)
        const aiErrorSnippet = out.length > 2000 ? out.substring(0, 2000) + '\n...[TRUNCATED]' : out;

        const files = [
            ...poms.map(p => `pages/${p.className}.ts:\n\`\`\`typescript\n${fs.readFileSync(`pages/${p.className}.ts`, 'utf-8')}\n\`\`\``),
            `tests/${specFile}:\n\`\`\`typescript\n${fs.readFileSync(specPath, 'utf-8')}\n\`\`\``,
        ].join('\n\n');

        // STRICT Prompt Engineering for the Healer
        const healerPrompt = `The tests failed. Fix the Playwright TypeScript code.

ERROR LOG:
${aiErrorSnippet}

CURRENT FILES:
${files}

DOM CONTEXT:
${domCtx}

CRITICAL HEALING RULES:
1. You MUST return EXACTLY ${N} code blocks enclosed in \`\`\`typescript ... \`\`\`.
2. DO NOT output any conversational text, apologies, or explanations outside the code blocks.
3. The first line of each block MUST be a comment with the exact file path (e.g., // pages/LoginPage.ts).
4. Provide the complete updated file content for all ${N} files.
5. DIAGNOSE INTERACTION FAILURES: If a click is intercepted by an overlay/modal, do NOT use hardcoded coordinates.
   Use semantic Playwright solutions to dismiss it, such as pressing Escape (\`await page.keyboard.press('Escape')\`) or interacting directly with the close button.
6. NEVER use waitForTimeout() — replace with web-first assertions that have auto-wait built in.
7. USE FALLBACK SELECTORS & SEMANTICS: If the error is "element(s) not found" or a Timeout, the current selector is a hallucination or brittle. 
   - STOP using IDs or classes for that element. 
   - SWITCH to semantic locators based on the DOM CONTEXT provided (e.g., page.getByRole('dialog'), page.getByRole('button', { name: 'Submit' }), or page.getByText('...')).
8. PRIORITIZE DOM: Use only attributes present in DOM CONTEXT. Do not assume generic classes like .modal-title.
9. DYNAMIC DATA: Map test data to actual DOM values (e.g., if DOM has 'Male', use 'Male' not 'male').
10. FORM VALIDATION (CRITICAL): For missing fields, ALWAYS use 'await expect(locator).toHaveJSProperty("validity.valid", false);'. NEVER use '.toHaveAttribute("required", "")' or '.not.toBeChecked()'.
11. RADIO/CHECKBOX PARADOX (FATAL ERROR): Separate clicking from validating! For CLICKING (in POM): ALWAYS use 'page.getByText("ExactLabel", { exact: true })'. NEVER use ':has-text()'. For VALIDATING (in Spec): MUST target the hidden input directly (e.g., input[type="radio"]).
12. NEGATIVE TEST ASSERTIONS (CRITICAL): In a for...of loop, you MUST use an if/else block to assert the 'validity.valid' state of the SPECIFIC missing field. Do NOT lazily assert that the modal is hidden.
13. NO WAITS IN POM: POM methods must ONLY perform actions. NEVER add 'await ...waitFor()' inside a POM.
14. NO TAG HALLUCINATION: NEVER append '.locator("text")' or invent tags. Assert text directly on the parent container.
15. EXACT MATCHING: When using getByRole for short words that could be substrings of others, ALWAYS use '{ exact: true }'.
16. ERROR SELECTOR FIXES (CRITICAL): If a locator for an error message fails with a Strict Mode Violation, you used a generic class that matched the input fields. Replace it with EXACTLY '[data-test="error"]' and append '.first()' to the assertion. NEVER use '[class*="error"]'.
17. LIST ITEM CLICKS: If a click fails due to Strict Mode (e.g., 6 "Add to cart" buttons found), prefer changing the locator to an exact unique ID (e.g., '[id="add-to-cart-sauce-labs-bike-light"]'). If no unique ID is available in the DOM context, append '.first()' to the locator.
18. TIMEOUTS IN LOOPS & SELECTORS (CRITICAL): If the error is 'Target page closed' or a Locator Timeout, check 3 things: 
    1) STATE LEAK: If iterating a 'for...of' loop, old data (like cart items) broke the flow. You MUST navigate first, then clear storage. Apply this exact pattern: await page.goto('URL_DEL_TEST'); await page.evaluate(() => { window.sessionStorage.clear(); window.localStorage.clear(); }).catch(() => {});
    2) MISSING LOGIN: Ensure the login step (if required) is explicitly called INSIDE the loop, right AFTER navigating and clearing the state.
    3) HALLUCINATED CASING: If a specific locator timed out, check the DOM context and fix the camelCase/kebab-case.`;



   
        const healed = await ai(ctx, healerPrompt);
        
        if (!saveCodeBlocks(healed, poms, specPath)) {
            console.error('Healer failed to parse AI correction. (The LLM likely output conversational text instead of strict code blocks)');
            break;
        }
        console.log('Code healed. Re-running...');
    }
    
    console.log('Max attempts reached. Review files manually.');
    return false;
}