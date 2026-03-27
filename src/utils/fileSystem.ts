// src/utils/fileSystem.ts
import fs from 'fs';
import { PomDef, Ticket } from '../types';

/**
 * Safely reads a file from disk. Returns null if not found.
 */
export const readFile = (fp: string): string | null => {
    return fs.existsSync(fp) ? fs.readFileSync(fp, 'utf-8') : null;
};

/**
 * Lowercases the first letter of a string.
 */
export const lcFirst = (s: string): string => {
    return s[0].toLowerCase() + s.slice(1);
};

/**
 * Manages the .feature file by creating it or appending new scenarios.
 */
export function appendFeature(path: string, ticket: Ticket, scenarios: string[]): void {
    if (!fs.existsSync('features')) fs.mkdirSync('features');
    
    let content = "";
    if (fs.existsSync(path)) {
        const existing = fs.readFileSync(path, 'utf-8');
        content = existing.trim() + '\n\n' + scenarios.join('\n\n') + '\n';
    } else {
        content = `Feature: ${ticket.id} - ${ticket.title}\n\n${scenarios.join('\n\n')}\n`;
    }
    fs.writeFileSync(path, content);
}

/**
 * Parses AI response and saves TypeScript blocks to their respective files.
 */
export function saveCodeBlocks(raw: string, poms: PomDef[], specPath: string): boolean {
    const blockRegex = new RegExp('\\x60\\x60\\x60(?:typescript|ts)([\\s\\S]*?)\\x60\\x60\\x60', 'g');
    const blocks = (raw.match(blockRegex) ?? []).map(b => 
        b.replace(/```(typescript|ts)/, '').replace(/```/, '').trim()
    );
    
    if (blocks.length < (poms.length + 1)) return false;

    if (!fs.existsSync('pages')) fs.mkdirSync('pages');
    if (!fs.existsSync('tests')) fs.mkdirSync('tests');
    
    let specWritten = false;
    for (const block of blocks) {
        const firstLine = block.split('\n')[0];
        const match = firstLine.match(/\/\/\s*(pages\/\S+\.ts|tests\/\S+\.ts)/);
        if (match) {
            fs.writeFileSync(match[1], block);
            if (match[1].startsWith('tests/')) specWritten = true;
        }
    }

    // Fallback if AI didn't provide headers
    if (!specWritten) {
        poms.forEach((p, i) => fs.writeFileSync(`pages/${p.className}.ts`, blocks[i]));
        fs.writeFileSync(specPath, blocks[poms.length]);
    }
    return true;
}

/**
 * Gets existing scenarios for context.
 */
export function globalCtx(): string {
    if (!fs.existsSync('features')) return '';
    return fs.readdirSync('features')
        .filter(f => f.endsWith('.feature'))
        .map(f => {
            const titles = fs.readFileSync(`features/${f}`, 'utf-8')
                .split('\n')
                .filter(l => l.trim().startsWith('Scenario'))
                .map(l => `  - ${l.trim()}`)
                .join('\n');
            return `${f}:\n${titles || '  (empty)'}`;
        }).join('\n\n');
}