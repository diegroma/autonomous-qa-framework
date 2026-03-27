# 🏛️ System Architecture: The "Why" Behind the Stack

When building an autonomous E2E QA Agent, the technology choices must balance reliability, speed, and cost. Here is why this stack was chosen:

### 1. The Core Testing Engine: Playwright (over Cypress/Selenium)
Playwright is the foundation of this framework because it is fundamentally designed for the modern web. 
- **Auto-waiting:** It eliminates flaky tests by waiting for elements to be actionable before interacting. This is critical because an AI cannot guess random `sleep()` intervals.
- **Web-First Assertions:** Assertions like `toBeVisible()` automatically retry until the condition is met, providing a massive safety net for AI-generated code.
- **Browser Contexts:** It spins up isolated contexts in milliseconds, allowing our Data-Driven tests to clear states (like shopping carts) efficiently without restarting the whole browser.

### 2. The LLM Engine: Groq API (over OpenAI/Anthropic)
Running an autonomous agent requires constant, massive context windows. Every time a test fails, the Auto-Healer sends the Error Log, the DOM snippet, and the full Code back to the AI.
- **Inference Speed:** Groq's LPU (Language Processing Unit) architecture processes tokens exponentially faster than traditional GPUs. When a test fails, the AI rewrites it in seconds, not minutes.
- **Cost-Efficiency:** QA automation requires heavy looping. The 5-attempt Auto-Healer loop creates massive context overhead. Utilizing fast and efficient models through Groq (like Llama 3.3) is critical to prevent the operational cost of the framework from becoming prohibitive.

### 3. The Orchestration: Agentic Workflow vs. Simple Generation
This is not a simple "prompt-to-code" wrapper. It is a multi-step Agentic Workflow:
- **Phase 1 (Blind Planning):** The AI plans navigation based strictly on business logic, preventing it from hallucinating non-existent buttons.
- **Phase 2 (Targeted Scraping):** Playwright physically visits the target, strips out noise (ads, hidden divs), and extracts ONLY actionable semantic elements (`data-test`, buttons).
- **Phase 3 (Guarded Generation):** The prompt strictly forbids inventing selectors. The AI can only map its BDD logic to the real DOM extracted in Phase 2.
- **Phase 4 (Closed-Loop Healing):** The system feeds its own execution failures back into the LLM, creating a self-correcting loop that mimics a junior QA engineer debugging their own script.