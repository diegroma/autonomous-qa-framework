// src/utils/jiraClient.ts
import axios from 'axios';
import dotenv from 'dotenv';
import inquirer from 'inquirer'; // <-- Añadido para los menús
import { Ticket } from '../types';

dotenv.config();

const JIRA_DOMAIN = process.env.JIRA_DOMAIN;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_TOKEN = process.env.JIRA_API_TOKEN;
const JIRA_PROJECT = process.env.JIRA_PROJECT || 'DEV';

const headers = {
    'Authorization': `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64')}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
};

function extractAdfText(node: any): string {
    if (!node) return '';
    if (node.type === 'text') return node.text || '';
    
    let text = '';
    if (Array.isArray(node.content)) {
        text = node.content.map((child: any) => extractAdfText(child)).join('');
    }
    
    if (node.type === 'paragraph') return text + '\n';
    if (node.type === 'listItem') return '  - ' + text; 
    return text;
}

export async function fetchReadyTickets(): Promise<Ticket[]> {
    if (!JIRA_DOMAIN || !JIRA_EMAIL || !JIRA_TOKEN) {
        throw new Error('❌ Missing Jira credentials in .env file');
    }

    const jql = `project = "${JIRA_PROJECT}" AND issuetype != Task AND statusCategory != Done ORDER BY created DESC`;
    const url = `${JIRA_DOMAIN}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,description&maxResults=15`;

    try {
        const response = await axios.get(url, { headers });
        
        return response.data.issues.map((issue: any) => {
            let plainDescription = 'No description';
            const desc = issue.fields?.description;

            if (desc) {
                if (Array.isArray(desc.content)) {
                    plainDescription = desc.content.map((node: any) => extractAdfText(node)).join('').trim();
                } else if (typeof desc === 'string') {
                    plainDescription = desc;
                }
            }

            return {
                id: issue.key,
                title: issue.fields?.summary || 'No title',
                description: plainDescription
            };
        });
    } catch (error: any) {
        console.error('❌ Error connecting to Jira:', error.response?.data || error.message);
        throw error;
    }
}

export async function fetchTicketById(issueKey: string): Promise<Ticket> {
    if (!JIRA_DOMAIN || !JIRA_EMAIL || !JIRA_TOKEN) {
        throw new Error('❌ Missing Jira credentials in .env file');
    }

    const url = `${JIRA_DOMAIN}/rest/api/3/issue/${issueKey}?fields=summary,description`;

    try {
        const response = await axios.get(url, { headers });
        const issue = response.data;
        
        let plainDescription = 'No description';
        const desc = issue.fields?.description;

        if (desc) {
            if (Array.isArray(desc.content)) {
                plainDescription = desc.content.map((node: any) => extractAdfText(node)).join('').trim();
            } else if (typeof desc === 'string') {
                plainDescription = desc;
            }
        }

        return {
            id: issue.key,
            title: issue.fields?.summary || 'No title',
            description: plainDescription
        };
    } catch (error: any) {
        throw new Error(`Ticket ${issueKey} not found or inaccessible in Jira.`);
    }
}

export async function createJiraTest(parentStoryKey: string, scenarioTitle: string, gherkin: string): Promise<string> {
    const payload = {
        fields: {
            project: { key: JIRA_PROJECT },
            summary: `[TEST] ${scenarioTitle}`,
            issuetype: { name: 'Task' }, 
            labels: ['MANUAL'], 
            description: {
                type: 'doc',
                version: 1,
                content: [
                    { type: 'paragraph', content: [{ type: 'text', text: 'Automatically generated BDD Scenario:\n' }] },
                    { type: 'codeBlock', attrs: { language: 'gherkin' }, content: [{ type: 'text', text: gherkin }] }
                ]
            }
        }
    };

    try {
        // Avoid duplicates: check if this test already exists for this US
        const existingTests = await getGeneratedTestsForUS(parentStoryKey);
        for (const key of existingTests) {
            const issue = await axios.get(
                `${JIRA_DOMAIN}/rest/api/3/issue/${key}?fields=summary`, 
                { headers }
            );
            if (issue.data.fields.summary === `[TEST] ${scenarioTitle}`) {
                console.log(`   ⚠️  Already exists: ${key} -> ${scenarioTitle}`);
                return key;
            }
        }

        const response = await axios.post(`${JIRA_DOMAIN}/rest/api/3/issue`, payload, { headers });
        const newTicketKey = response.data.key;

        await axios.post(`${JIRA_DOMAIN}/rest/api/3/issueLink`, {
            type: { name: 'Relates' },
            inwardIssue: { key: newTicketKey },
            outwardIssue: { key: parentStoryKey }
        }, { headers });

        return newTicketKey; 
    } catch (error: any) {
        console.error('❌ Error creating Test in Jira:', error.response?.data || error.message);
        throw error;
    }
}

export async function updateJiraLabels(issueKey: string, labels: string[]): Promise<void> {
    const current = await axios.get(
        `${JIRA_DOMAIN}/rest/api/3/issue/${issueKey}?fields=labels`,
        { headers }
    );
    const existing: string[] = current.data.fields.labels || [];
    const merged = [...new Set([...existing.filter(l => l !== 'MANUAL'), ...labels])];
    const payload = { fields: { labels: merged } };
    
    try {
        await axios.put(`${JIRA_DOMAIN}/rest/api/3/issue/${issueKey}`, payload, { headers });
    } catch (error: any) {
        console.error(`❌ Error updating labels for ${issueKey}:`, error.response?.data || error.message);
    }
}

export async function getGeneratedTestsAll(): Promise<string[]> {
    const jql = `project = "${JIRA_PROJECT}" AND issuetype = Task`;
    const url = `${JIRA_DOMAIN}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary&maxResults=100`;
    
    try {
        const response = await axios.get(url, { headers });
        return response.data.issues
            .filter((issue: any) => issue.fields.summary.startsWith('[TEST]'))
            .map((issue: any) => issue.key);
    } catch (error) {
        console.error('❌ Error fetching all tests from Jira');
        return [];
    }
}

export async function getGeneratedTestsForUS(usKey: string): Promise<string[]> {
    try {
        const response = await axios.get(
            `${JIRA_DOMAIN}/rest/api/3/issue/${usKey}?fields=issuelinks,summary`, 
            { headers }
        );
        const links = response.data.fields.issuelinks || [];
        const testKeys: string[] = [];

        for (const link of links) {
            const linkedIssue = link.inwardIssue || link.outwardIssue;
            if (linkedIssue && linkedIssue.fields.summary.startsWith('[TEST]')) {
                testKeys.push(linkedIssue.key);
            }
        }
        return testKeys;
    } catch (error) {
        throw new Error(`Could not find User Story ${usKey}`);
    }
}

export async function deleteJiraTicket(issueKey: string): Promise<void> {
    try {
        await axios.delete(`${JIRA_DOMAIN}/rest/api/3/issue/${issueKey}`, { headers });
    } catch (error: any) {
        console.error(`❌ Error deleting ${issueKey}:`, error.response?.data || error.message);
        throw error;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERACTIVE CLI PROMPTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handles the interactive terminal menu to fetch and select a Jira Ticket
 */
export async function promptForJiraTicket(): Promise<Ticket> {
    const { mode } = await inquirer.prompt([{
        type: 'list',
        name: 'mode',
        message: 'How do you want to select the User Story?',
        choices: [
            { name: 'Enter User Story ID manually (e.g., DEV-5)', value: 'MANUAL' },
            { name: 'Select from open User Stories in Jira', value: 'FETCH' }
        ]
    }]);

    if (mode === 'MANUAL') {
        const { usKey } = await inquirer.prompt([{
            type: 'input',
            name: 'usKey',
            message: 'Enter the User Story ID:',
            validate: (input) => input.trim().length > 0 ? true : 'Please enter an ID'
        }]);

        console.log(`\n📡 Fetching ${usKey.toUpperCase()} from Jira...`);
        try {
            return await fetchTicketById(usKey.trim().toUpperCase());
        } catch (e: any) {
            console.error(`❌ ${e.message}`);
            process.exit(1);
        }
    } else {
        console.log('\n📡 Connecting to Jira and fetching open tickets...');
        const tickets = await fetchReadyTickets();
        
        if (!tickets.length) { 
            console.error('No open User Stories found in Jira.'); 
            process.exit(1); 
        }

        const { sel } = await inquirer.prompt([{ 
            type: 'list', 
            name: 'sel', 
            message: 'Which Jira ticket do you want to process?', 
            choices: tickets.map(t => ({ name: `[${t.id}] ${t.title}`, value: t.id })) 
        }]);
        
        return tickets.find(t => t.id === sel)!;
    }
}