// src/e2e-jira-generator.ts
import dotenv from 'dotenv';
dotenv.config(); // Load variables at the very beginning

import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import { Ticket, INFRA } from './types';
import { globalCtx, readFile } from './utils/fileSystem';
import { makePlan, makeBdd, makeCode } from './ai/prompts';
import { scrape } from './scraper/playwrightDom';
import { heal } from './healer/autoHealer';
import { createJiraTest, updateJiraLabels, promptForJiraTicket } from './utils/jiraClient';

/**
 * ── MAIN ORCHESTRATOR (JIRA VERSION) ──
 */
async function main() {
    const agentCtx = fs.readFileSync(path.join('agents', 'qualia.agent.md'), 'utf-8');

     // 1. Ask the user how they want to select the ticket
    const ticket = await promptForJiraTicket();
    
    // 2. Confirm and display the selected ticket
    console.log(`\n✅ Loaded from Jira: [${ticket.id}] ${ticket.title}`);
    console.log(`   Description:\n${ticket.description.slice(0, 200)}...\n`);

    // 3. Planning phase
    console.log('Planning navigation...');
    const { navFlow, pomDefs, specStem } = await makePlan(agentCtx, ticket);
    const specFile = `${specStem}.spec.ts`;
    const specPath = path.join('tests', specFile);
    console.log('   Path:', navFlow.map(s => `${s.page}(${s.action})`).join(' -> '));
    console.log('   POMs to create:', pomDefs.map(p => p.className).join(', '));
    console.log('   Spec file:', specFile);

    // 4. Scraping phase
    const domMap = await scrape(navFlow);
    const featPages = Object.fromEntries(Object.entries(domMap).filter(([pg]) => !INFRA.has(pg)));
    const domSummary = Object.entries(featPages).map(([pg, loc]) => `### ${pg}\n${loc}`).join('\n\n');

    // 5. BDD Generation
    console.log('\nGenerating test scenarios (BDD)...');
    if (!fs.existsSync('features')) fs.mkdirSync('features');
    const featPath = `features/${ticket.id}.feature`;
    const gherkin  = await makeBdd(agentCtx, ticket, domSummary, readFile(featPath), globalCtx());
    
    const blockRegex2 = new RegExp('\\x60\\x60\\x60(?:gherkin)?', 'ig');
    const blockRegex3 = new RegExp('\\x60\\x60\\x60', 'g');
    const cleanGherkin = gherkin.replace(blockRegex2, '').replace(blockRegex3, '').trim();
    
    const blocks = cleanGherkin.split(/(?=Scenario:|Scenario Outline:)/).map(b => b.trim()).filter(Boolean);
    if (!blocks.length) { console.error('No valid scenarios generated.'); return; }

    // 6. Approve Scenarios
    const { toSave } = await inquirer.prompt([{ type: 'checkbox', name: 'toSave', message: 'APPROVE scenarios to save:', choices: blocks.map(b => ({ name: b.split('\n')[0], value: b })) }]);
    if (!toSave.length) { console.log('Operation cancelled. Nothing approved.'); return; }
    
    // 7. Save Locally
    let finalFeatureContent = "";
    if (fs.existsSync(featPath)) {
        const existingContent = fs.readFileSync(featPath, 'utf-8');
        finalFeatureContent = existingContent.trim() + '\n\n' + toSave.join('\n\n') + '\n';
    } else {
        finalFeatureContent = `Feature: ${ticket.id} - ${ticket.title}\n\n${toSave.join('\n\n')}\n`;
    }
    fs.writeFileSync(featPath, finalFeatureContent);
    console.log(`Created/Updated feature file -> ${featPath}`);

    //Store the Jira Ticket ID for each Scenario Title 🔥
    const jiraTicketsMap: Record<string, string> = {};

    console.log('\n☁️  Uploading tests to Jira...');
    for (const bdd of toSave) {
        const titleLine = bdd.split('\n').find((l: string) => l.includes('Scenario:') || l.includes('Scenario Outline:'));
        const cleanTitle = titleLine ? titleLine.replace(/Scenario:|Scenario Outline:/g, '').trim() : 'Test Case';
        
        try {
            const newTicketId = await createJiraTest(ticket.id, cleanTitle, bdd);
            jiraTicketsMap[cleanTitle] = newTicketId; // Save the ID associated with the title
            console.log(`   🔗 Created Jira ticket: ${newTicketId} -> ${cleanTitle} (MANUAL)`);
        } catch (error) {
            console.log(`   ❌ Failed to upload to Jira: ${cleanTitle}`);
        }
    }

    // 8. Automate Selection
    console.log('\n');
    const { toAuto } = await inquirer.prompt([{ type: 'checkbox', name: 'toAuto', message: 'Which ones do you want to AUTOMATE right now?', choices: toSave.map((b: string) => ({ name: b.split('\n')[0], value: b })) }]);
    if (!toAuto.length) { console.log('Operation cancelled. No code will be generated.'); return; }

    // 9. Code Generation
    console.log('\nGenerating Playwright code...');
    const code = await makeCode(agentCtx, ticket, toAuto, pomDefs, featPages, specFile, navFlow);

    // 10. Auto-Healer (Capturing the execution result)
    const allPassed = await heal(agentCtx, code, pomDefs, featPages, specFile, specPath);

    // 11. Update Jira with execution results
    console.log('\n🏷️  Updating Jira tickets with execution results...');
    const statusLabel = allPassed ? 'PASSED' : 'FAILED';

    for (const bdd of toAuto) {
        const titleLine = bdd.split('\n').find((l: string) => l.includes('Scenario:') || l.includes('Scenario Outline:'));
        const cleanTitle = titleLine ? titleLine.replace(/Scenario:|Scenario Outline:/g, '').trim() : 'Test Case';
        
        const ticketId = jiraTicketsMap[cleanTitle];
        if (ticketId) {
            // Replace the 'MANUAL' label with 'AUTOMATED' and the execution status
            await updateJiraLabels(ticketId, ['AUTOMATED', statusLabel]);
            console.log(`   ✅ Updated ${ticketId} -> AUTOMATED, ${statusLabel}`);
        }
    }
}

main().catch(e => { 
    console.error('❌ Fatal error:', e.message);
    console.error('Stack trace:', e.stack);

    // Log the error to a file for later analysis
    fs.appendFileSync('error.log', `${new Date().toISOString()} - ${e.stack}\n`);
    process.exit(1); 
});