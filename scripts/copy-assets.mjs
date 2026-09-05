import { cpSync, mkdirSync } from 'fs';

mkdirSync('dist/images/pages', { recursive: true });
cpSync('src/images/pages', 'dist/images/pages', { recursive: true });
mkdirSync('dist/bot/resources', { recursive: true });
cpSync('src/bot/resources', 'dist/bot/resources', { recursive: true });
console.log('Copied image templates and resources to dist/');
