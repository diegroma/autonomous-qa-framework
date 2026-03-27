// src/utils/clean.ts
import fs from 'fs';
import inquirer from 'inquirer';
import dotenv from 'dotenv';
import { getGeneratedTestsAll, getGeneratedTestsForUS, deleteJiraTicket } from './jiraClient';

dotenv.config();

async function main() {
    console.log('🧹 Welcome to the Cleanup Utility\n');

    // 1. Ask WHAT to clean using a multi-select checkbox
    const { targets } = await inquirer.prompt([{
        type: 'checkbox',
        name: 'targets',
        message: 'What do you want to clean? (Press <space> to select, <enter> to confirm)',
        choices: [
            { name: 'Local generated files (features/, pages/, tests/)', value: 'LOCAL', checked: true },
            { name: 'Jira generated tests ([TEST] tasks)', value: 'JIRA' }
        ]
    }]);

    if (targets.length === 0) {
        console.log('✨ Nothing selected. Workspace is untouched.');
        return;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // LOCAL CLEANUP
    // ─────────────────────────────────────────────────────────────────────────────
    if (targets.includes('LOCAL')) {
        console.log('\n🧹 Cleaning up local generated files...');
        const directoriesToClean = ['features', 'pages', 'tests'];

        directoriesToClean.forEach(dir => {
            if (fs.existsSync(dir)) {
                fs.rmSync(dir, { recursive: true, force: true });
                console.log(`  🗑️  Deleted: ${dir}/`);
            } else {
                console.log(`  ✅ Already clean: ${dir}/`);
            }
        });
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // JIRA CLEANUP
    // ─────────────────────────────────────────────────────────────────────────────
    if (targets.includes('JIRA')) {
        console.log('\n☁️  Starting Jira Cleanup...');
        
        // Ask for the scope (ALL or Specific User Story)
        const { scope } = await inquirer.prompt([{
            type: 'list',
            name: 'scope',
            message: 'Delete ALL tests or only for a specific User Story?',
            choices: [
                { name: 'ALL generated tests in the project', value: 'ALL' },
                { name: 'Only tests linked to a specific User Story', value: 'SPECIFIC' }
            ]
        }]);

        let ticketsToDelete: string[] = [];

        // Fetch the tickets based on scope
        if (scope === 'ALL') {
            console.log('📡 Fetching all generated tests...');
            ticketsToDelete = await getGeneratedTestsAll();
        } else {
            const { usKey } = await inquirer.prompt([{
                type: 'input',
                name: 'usKey',
                message: 'Enter the User Story ID (e.g., DEV-5):',
                validate: (input) => input.trim().length > 0 ? true : 'Please enter an ID'
            }]);
            
            console.log(`📡 Fetching tests linked to ${usKey.toUpperCase()}...`);
            try {
                ticketsToDelete = await getGeneratedTestsForUS(usKey.trim().toUpperCase());
            } catch (e) {
                console.log(`❌ Could not fetch ${usKey}. Make sure it exists.`);
            }
        }

        if (ticketsToDelete.length === 0) {
            console.log('🤷 No [TEST] tickets found to delete in Jira.');
        } else {
            // Final Confirmation
            console.log(`\n⚠️  Found ${ticketsToDelete.length} tests to delete: ${ticketsToDelete.join(', ')}`);
            const { confirmDelete } = await inquirer.prompt([{
                type: 'confirm',
                name: 'confirmDelete',
                message: `Are you SURE you want to permanently delete these ${ticketsToDelete.length} tickets from Jira?`,
                default: false
            }]);

            if (confirmDelete) {
                for (const key of ticketsToDelete) {
                    try {
                        await deleteJiraTicket(key);
                        console.log(`   🗑️ Deleted Jira ticket: ${key}`);
                    } catch (e) {
                        console.log(`   ❌ Failed to delete ${key}`);
                    }
                }
                console.log('\n✨ Jira cleanup complete!');
            } else {
                console.log('\nOperation cancelled. Jira was untouched.');
            }
        }
    }

    console.log('\n✨ All requested cleanups finished successfully!');
}

main().catch(e => console.error('Uncaught error:', e));