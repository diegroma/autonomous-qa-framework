// src/ai/prompts.ts
import fs from 'fs';
import dotenv from 'dotenv';
import { ai } from './groqClient';
import { Ticket, Plan, PomDef, NavStep, DomMap, INFRA } from '../types';
import { readFile, lcFirst } from '../utils/fileSystem';

dotenv.config();
const TARGET_URL = process.env.TARGET_URL;

/**
 * CALL 1: Planning Phase
 * CONTEXT ISOLATION: This phase uses its OWN System Prompt.
 * We ignore 'ctx' (qualia.agent.md) so strict [data-test] rules
 * do not conflict with the need to navigate blindly.
 */
export async function makePlan(ctx: string /* ignored here */, ticket: Ticket): Promise<Plan> {
    if (!TARGET_URL) throw new Error('TARGET_URL not defined in .env');
    
    const existing = fs.existsSync('pages') 
        ? fs.readdirSync('pages').filter(f => f.endsWith('.ts')).map(f => f.replace('.ts', '')) 
        : [];

    // 🧠 ISOLATED BRAIN FOR THE PLANNER
    const systemPrompt = `You are a specialized Navigation Planner for a Playwright headless scraper.
Your ONLY goal is to figure out the sequence of clicks and fills needed to reach the core feature described in the ticket.

CRITICAL RULES:
1. YOU ARE BLIND: You do not have the DOM yet.
2. AGNOSTICISM: Never assume the app domain (e.g., e-commerce, CRM, social). Use ONLY info from the ticket.
3. SELECTOR STRATEGY: Provide multiple likely selectors separated by commas for EVERY action.
   - PRIORITY: Put specific attributes ([data-test], [id], [name], [aria-label], [placeholder]) BEFORE generic tags.
   - AVOID WILDCARDS: NEVER use '*=' (contains) for very common words like 'cart', 'btn', or 'item'. It causes strict mode violations because it matches too many elements.
   - NAVIGATION/LINKS: Prefer exact attributes. Example: "[data-test='shopping-cart-link']", "[id='cart']".
   - BUTTONS: Use exact text or test attributes: "button:has-text('Exact Action')", "[data-test='action-btn']".
   - FIELDS: Prefer exact ID or name: "[id='field-id']", "[name='field_name']", "[data-test='field']".
4. NOISE REDUCTION & EFFICIENCY: To save tokens and avoid fatal errors, IGNORE obvious advertisement containers, social media widgets, or decorative iframes (e.g., selectors containing 'google_ads', 'banner', 'ad-wrapper'). Focus strictly on the functional path.
5. NO PLACEHOLDERS: NEVER use '<RESOLVE_FROM_DOM>'.
6. POM NAMING: Use domain-neutral names found in the ticket (e.g., 'DashboardPage', 'UserListPage', 'FormPage').
7. AUTHENTICATION: If 'Global Auth Data' is provided, you MUST ALWAYS include login steps at the very beginning of the navFlow. Assume the target application globally requires authentication to access any internal feature. Do this even if the ticket description does not explicitly mention logging in.`;

    const userPrompt = `
Ticket title      : ${ticket.title}
Ticket description: ${ticket.description}
Base URL          : ${TARGET_URL}
Global Auth Data  : ${process.env.AUTH_USERNAME ? `ALWAYS prepend login steps to the navFlow using these exact credentials: "${process.env.AUTH_USERNAME}" and "${process.env.AUTH_PASSWORD}".` : 'No auth required'}
Existing POMs     : ${existing.length ? existing.join(', ') : 'none'}

Return ONLY a JSON object (ADAPT IT TO THE TICKET):
{
  "navFlow": [
    { "page": "root", "action": "goto", "url": "${TARGET_URL}" },
    { "page": "targetPage", "action": "fill", "selector": "input[type='text'], input[placeholder*='sername'], [id*='user']", "value": "demo_data" },
    { "page": "targetPage", "action": "click", "selector": "button:has-text('Submit'), input[type='submit']" }
  ],
  "pomDefs": [
    { "className": "FeaturePage", "fileStem": "feature", "domPages": ["targetPage"] }
  ],
  "specStem": "feature_name"
}
Return ONLY valid JSON. No markdown fences.`;

    // Call the AI with the isolated brain
    const raw = await ai(systemPrompt, userPrompt);

    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Plan response not JSON: ' + raw.slice(0, 200));
    const p = JSON.parse(m[0]);

    const clean = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '');
    const pomDefs: PomDef[] = (p.pomDefs ?? []).map((d: any) => ({
        className: clean(d.className ?? 'Page').replace(/^[a-z]/, (c: string) => c.toUpperCase()),
        fileStem:  clean(d.fileStem ?? 'page').toLowerCase(),
        domPages:  d.domPages ?? [],
    })).filter((d: PomDef) => !d.domPages.every((pg: string) => INFRA.has(pg)));

    const navFlow: NavStep[] = (p.navFlow ?? []);
    if (navFlow[0]?.action !== 'goto') navFlow.unshift({ page: 'root', action: 'goto', url: TARGET_URL! });

    return { navFlow, pomDefs, specStem: clean(p.specStem ?? 'spec').toLowerCase() };
}


/**
 * CALL 2: BDD Phase
 */
export async function makeBdd(ctx: string, ticket: Ticket, dom: string, existing: string|null, global_: string): Promise<string> {
    return ai(ctx, `
Ticket: ${ticket.title}
Description: ${ticket.description}

DOM (scraped live):
${dom}

${global_ ? 'ALREADY COVERED IN OTHER TICKETS:\n' + global_ + '\n' : ''}
${existing ? 'EXISTING SCENARIOS:\n' + existing + '\n' : ''}

CRITICAL OUTPUT RULES:
1. Return ONLY pure Gherkin text. No markdown, no explanations, no bold text.
2. Start directly with 'Scenario:' or 'Scenario Outline:'.

CRITICAL SCENARIO DESIGN RULES:
1. THE OUTCOME RULE: 
   - If Outcome(A) == Outcome(B) (exactly same system state/message) -> Use 'Scenario Outline'.
   - If Outcome(A) != Outcome(B) (different results or unique error messages) -> Use SEPARATE 'Scenario' blocks.
   - Example: "Validation A fails" vs "Validation B fails" are DIFFERENT outcomes.
2. NO REDUNDANCY: One Happy Path per feature covering the complete flow end-to-end.
   NEVER create a separate scenario for an intermediate state of the happy path.
   All steps of a single successful journey belong in ONE scenario.
3. STRICT COVERAGE: For each group of ACs, apply the OUTCOME RULE first:
   - If ALL ACs in the group produce the EXACT SAME outcome → one Scenario Outline,
     one Examples row per AC. Do NOT generate individual Scenarios for those ACs.
   - If ANY AC produces a different outcome → one Scenario per AC.
   Never generate both an Outline AND individual Scenarios for the same group.
4. TITLE QUALITY: Descriptive (5-8 words), outcome-focused, and unique. No technical terms.
   The title must describe WHAT succeeds or fails AND the condition.
   BAD:  "Action succeeds when all conditions are met correctly"
   GOOD: "Successful action with valid data"
   BAD:  "Feature is inaccessible when precondition is not satisfied"
   GOOD: "Feature blocked without precondition"
5. REDUNDANCY CHECK: If a scenario's Given state requires another scenario to have 
   completed first, or if it covers a step already included in the happy path → delete it.
`);
}

/**
 * CALL 3: Code Generation Phase
 */
export async function makeCode(ctx: string, ticket: Ticket, scenarios: string[], poms: PomDef[], dom: DomMap, specFile: string, navFlow: NavStep[]): Promise<string> {
    const domCtx  = poms.map(p => `=== LOCATORS STRICTLY FOR ${p.className} ===\n${p.domPages.map(pg => `[${pg}]:\n${dom[pg] || '(none)'}`).join('\n')}`).join('\n\n');
    
    const mergeCtx = [
        ...poms.map(p => { const s = readFile(`pages/${p.className}.ts`); return s ? `EXISTING pages/${p.className}.ts:\n\`\`\`typescript\n${s}\n\`\`\`` : null; }),
        (() => { const s = readFile(`tests/${specFile}`); return s ? `EXISTING tests/${specFile}:\n\`\`\`typescript\n${s}\n\`\`\`` : null; })(),
    ].filter(Boolean).join('\n\n');

    const imports = poms.map(p => `import { ${p.className} } from '../pages/${p.className}';`).join('\n');
    const lets    = poms.map(p => `  let ${lcFirst(p.className)}: ${p.className};`).join('\n');
    const inits   = poms.map(p => `    ${lcFirst(p.className)} = new ${p.className}(page);`).join('\n');
    const N = poms.length + 1;

    const flowDocs = navFlow.filter(s => s.action !== 'goto').map(s => `  // -> ${s.action} on ${s.page} ${s.selector ? '('+s.selector+')' : ''}`).join('\n');

    return ai(ctx, `
Write Playwright TypeScript tests for:
${scenarios.join('\n\n')}

DOM LOCATORS (PRIORITY: Use [data-test] first, then aria-label, id, name, placeholder. Generate fallback chains for EVERY locator):
${domCtx}

NAVIGATION FLOW (CONVERT THIS INTO ACTUAL TEST CODE - DO NOT HARDCODE CLICKS):
${flowDocs}

${mergeCtx ? 'EXISTING FILES — MERGE DO NOT OVERWRITE:\n' + mergeCtx + '\n' : ''}

FRAMEWORK: PLAYWRIGHT NOT JEST/VITEST

POM SKELETON (CRITICAL: NO EXPECT IN POMS. Use fallback locators. Include navigation methods from navFlow):
  import { Page, Locator } from '@playwright/test';
  export class MyPage {
    readonly page: Page;
    readonly myBtn: Locator;
    constructor(page: Page) { this.page = page; this.myBtn = page.locator('[data-test="btn"], [id="btn"], [aria-label*="btn"]'); }
    async doAction() { await this.myBtn.click(); }
    async navigateToFeature() { 
      // Convert navFlow steps to Playwright actions
      // Example: for each step, if action === 'click', await this.page.locator(step.selector).first().click();
      // Use fallback selectors from step.selector (comma-separated)
    }
  }

SPEC SKELETON:
  import { test, expect } from '@playwright/test';
${imports}
  test.describe('${ticket.title}', () => {
${lets}
    test.beforeEach(async ({ page }) => {
      await page.route('**/*', route => {
        if (/googlesyndication|doubleclick|adsbygoogle|googletagmanager/.test(route.request().url())) {
          route.abort();
        } else {
          route.continue();
        }
      });
      await page.goto('${TARGET_URL}');
      await page.addStyleTag({ content: '[id*="google_ads"], [class*="adsbygoogle"], [id*="ad-"], [class*="ad-banner"], [id*="fixedban"], [class*="overlay"] { display: none !important; pointer-events: none !important; }' });
${inits}
      // Put login steps here ONLY IF the ticket requires authentication.
    });

    test('Scenario Name', async ({ page }) => {
      // ARRANGE
      // ACT
      // ASSERT
    });
  });

DOM INTERPRETATION RULES (infer from the DOM provided above, never hardcode):
- FORCE ACTIONS FORBIDDEN: NEVER use { force: true } anywhere. Rely on Playwright's auto-wait. 
  If an element is not interactable, it means the selector is incorrect or the navigation flow is wrong. 
  This will be caught by the Healer.
- NO WAITS IN POM: POM methods must ONLY perform actions (click, fill). NEVER add 'await this.someElement.waitFor()' inside a POM method like submitForm(). Waiting for outcomes (like a modal appearing) belongs STRICTLY in the spec file using 'await expect(modal).toBeVisible()'.
- RADIO/CHECKBOX PARADOX (FATAL ERROR): You must separate clicking from validating!
  1) For CLICKING (in POM): Use exact text matching to avoid strict mode violations. ALWAYS use 'page.getByText("ExactLabel", { exact: true })'. CRITICAL CONDITIONAL LOGIC: NEVER use a generic 'else' block as a catch-all. You MUST dynamically read the available radio/checkbox options from the provided DOM context and generate strict 'if' / 'else if' blocks for EACH specific valid option (e.g., if the DOM shows options A, B and C, write: if (val === 'A') {...} else if (val === 'B') {...} else if (val === 'C') {...}). If the input is empty ('') or undefined, DO NOT click anything.
  2) For VALIDATING (in Spec): NEVER use the text/label. You MUST target the hidden input directly. Example: 'await expect(page.locator("input[type=\\"radio\\"]").first()).toHaveJSProperty("validity.valid", false);'.
- FORM VALIDATION & NEGATIVE TESTS (CRITICAL): Look at the provided DOM context to decide how to assert errors. 
  1) If the DOM uses custom error containers (e.g., '[data-test="error"]'), you MUST assert on that container: 'await expect(page.locator('[data-test="error"]')).toBeVisible();'.
  2) ONLY use 'toHaveJSProperty("validity.valid", false)' if the DOM uses native HTML5 validation and lacks explicit error containers.
  3) NEVER hallucinate attribute casing. If the DOM says '[data-test="firstName"]', DO NOT write '[data-test="first-name"]'. Use EXACT matches.
- NEGATIVE TEST ASSERTIONS (CRITICAL): In a for...of loop, you MUST use an if/else block to assert the 'validity.valid' state of the SPECIFIC missing field. DO NOT lazily assert that the modal is hidden.
- NEVER use CSS pseudo-selectors like :first, :last, :nth-child inside locator strings.
  Use .first() or .nth() as Playwright methods only when strictly necessary.
- Table cell assertions: to get a value from a labeled row, scope to the row first: page.locator('tr').filter({ hasText: 'Row Label' }).locator('td').locator('nth=1')
  NEVER use td:has-text("Label") + td — fragile and order-dependent.
  Infer the assertion from what the DOM provides:
  - If input has 'aria-invalid' attribute in DOM → toHaveAttribute('aria-invalid', 'true')
  - If there is a visible error message element → toContainText on that element
  - Otherwise → toHaveJSProperty('validity.valid', false)
- NEVER use toBeFocused() for validation assertions.
- NEVER use textContent() to extract text — always assert directly on the locator.
- DATA MAPPING: Extract actual form options/values from DOM and map generic test data to app-specific terminology. For example, if DOM has 'Male' and 'Female', map 'male' to 'Male'.
- MODALS & DIALOGS: If the DOM snippet shows a 'dialog' role (e.g., '- dialog "Title" [active]'), you MUST use page.getByRole('dialog') to locate it. NEVER invent generic IDs like '[id="example-modal"]'.
- NO TAG HALLUCINATION (FATAL ERROR): NEVER invent generic HTML tags like '.locator("p")', '.locator("div")', '.locator("span")', or '.locator("text")'. When asserting that specific text (like a submitted name or number) appears inside a modal or dialog, expose ONLY the main container in the POM (e.g., 'this.successModal = page.getByRole("dialog")'). Do NOT create separate locators in the POM for the inner content. In the spec file, assert directly on the main container: 'await expect(pageObj.successModal).toContainText("Expected Text")'.
- STRICT DOM MATCHING: You are strictly forbidden from writing a selector containing an 'id', 'name', or 'class' that does not explicitly appear in the DOM context provided.
- EXACT MATCHING: When using getByRole or getByText for short words that could be substrings of others (like "Male" being inside "Female"), ALWAYS use '{ exact: true }' to prevent strict mode violations.

RULES:
1. Every test() and test.beforeEach() MUST destructure ({ page }).
2. Web-first assertions only: await expect(locator).toContainText('x').
3. Data-driven: one test() with for...of loop ONLY for Scenario Outlines.
4. THE "BEFORE EACH" RULE: Keep test.beforeEach() strictly for navigation (goto) and POM initialization. IF the navFlow contains login steps, implement them inside beforeEach() using the generated POM. CRITICAL: Pass 'process.env.AUTH_USERNAME!' and 'process.env.AUTH_PASSWORD!' to the POM login method. NEVER hardcode real user data in the spec file.
5. STRICT POM PATTERN: NEVER import or use 'expect' inside pages/*.ts. Assertions belong ONLY in tests/*.spec.ts files.
6. FOCUS ON BUSINESS LOGIC: Do NOT write implementation details like "click this selector". Instead, use the POM methods.
7. EXACTLY ${N} FILES: Generate code for ALL POMs AND the spec file in a SINGLE RESPONSE.
8. AD BLOCKING: The FIRST lines of test.beforeEach() must always be the route blocker,
   BEFORE page.goto():
   await page.route('**/*', route => {
     if (/googlesyndication|doubleclick|adsbygoogle|googletagmanager/.test(route.request().url())) {
       route.abort();
     } else {
       route.continue();
     }
   });
9. LOOP NAVIGATION & STATE RESET: In a for...of loop for negative scenarios, the browser state MUST be completely reset. You MUST navigate first, then clear storage, then authenticate.
   ALWAYS use this exact pattern:
   for (const testCase of testCases) {
     await page.goto('${TARGET_URL}');
     await page.evaluate(() => { window.sessionStorage.clear(); window.localStorage.clear(); }).catch(() => {});
     // IF GLOBAL AUTH IS REQUIRED: Call your generated login POM method here
     // ACT & ASSERT
   }
10. NEVER add getter methods (getX(), getTitle(), getContent()) in POM files.
    Expose locators as public readonly Locator properties and assert directly in the spec:
    WRONG: const text = await pomPage.getTitle(); expect(text).toContain('x');
    RIGHT: await expect(pomPage.title).toContainText('x');
11. LOCATOR SPECIFICITY & STRICT MODE (CRITICAL): 
    - ERROR CONTAINERS: When locating error messages, you MUST ONLY use exact attributes like '[data-test="error"]'. You are STRICTLY FORBIDDEN from using '[class*="error"]' or '[id*="error"]' (they select the input fields instead of the text). ALWAYS append '.first()' when asserting on error message containers to bypass strict mode.
    - LIST ITEM SELECTION: When interacting with items in a list (e.g., products), NEVER use generic attributes like '[data-test="add-to-cart"]' on their own. PREFERRED: Use the exact unique ID if available (e.g., '[id="add-to-cart-sauce-labs-bike-light"]'). FALLBACK: Scope by product name using Playwright's filter. LAST RESORT: Only use '.first()' if no specific item is mentioned in the ticket.
12. Modal dismissal with Escape: ONLY in the happy path, after asserting the modal
    is visible and its content. Pattern:
    await expect(modalLocator).toBeVisible();
    await expect(modalLocator).toContainText('expected content');
    await page.keyboard.press('Escape');
    await expect(modalLocator).not.toBeVisible();
    NEVER use Escape in negative/validation tests — no modal appears when validation fails.

CRITICAL AGNOSTIC COMPLIANCE — FAILURE TO COMPLY WILL REJECT THE CODE:
- NEVER generate hardcoded URLs like 'https://example.com' — use '${TARGET_URL}' only.
- NEVER use app-specific names like 'demoqa', 'login', or menu labels.
- NEVER assume generic classes like '.modal-title', '.modal-body', or Bootstrap-specific selectors.
- Map all test data to actual DOM values (e.g., extract gender options from DOM and use 'Male' not 'male').
- Implement navFlow as actual POM methods — no hardcoded navigation steps.

VIOLATION DETECTION: The system will scan for forbidden patterns and reject non-compliant code. Ensure 100% agnostic generation.

Return EXACTLY ${N} typescript blocks in order:

${poms.map((p, i) => `  Block ${i+1}: pages/${p.className}.ts`).join('\n')}
  Block ${N}: tests/${specFile}
The FIRST LINE of every block must be a comment with its filepath, exactly like this:
  \`\`\`typescript
  // pages/${poms[0]?.className}.ts
No text outside code blocks.
`);
}