// src/types.ts

// Defines the structure of a Jira/User ticket
export interface Ticket { 
    id: string; 
    title: string; 
    description: string; 
}

// Defines a single navigation step for the scraper
export interface NavStep { 
    page: string; 
    action: 'goto' | 'click' | 'fill'; 
    url?: string; 
    selector?: string; 
    value?: string; 
}

// Defines a Page Object Model mapping
export interface PomDef { 
    className: string; 
    fileStem: string; 
    domPages: string[]; 
}

// Defines the overall AI execution plan
export interface Plan { 
    navFlow: NavStep[]; 
    pomDefs: PomDef[]; 
    specStem: string; 
}

// Maps page names to their extracted DOM locators
export type DomMap = Record<string, string>;

// Infrastructure pages that do not require a specific POM (e.g., the root entry point)
export const INFRA = new Set(['root']);