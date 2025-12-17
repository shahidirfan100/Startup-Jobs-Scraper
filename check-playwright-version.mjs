import fs from 'node:fs';

const dockerfile = fs.readFileSync('./Dockerfile', 'utf-8');
const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));

const fromLine = dockerfile
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.toLowerCase().startsWith('from '));

if (!fromLine) {
    console.log('check-playwright-version: no FROM line found, skipping.');
    process.exit(0);
}

const tagMatch = fromLine.match(/:([^\s]+)\s*$/);
const imageTag = tagMatch?.[1] || '';
const playwrightFromTag = imageTag.match(/\d+\.\d+\.\d+/)?.[0] || null;

const playwrightDep = pkg?.dependencies?.playwright || pkg?.devDependencies?.playwright || null;
const playwrightFromPkg = typeof playwrightDep === 'string' ? playwrightDep.match(/\d+\.\d+\.\d+/)?.[0] : null;

if (!playwrightFromTag || !playwrightFromPkg) {
    console.log('check-playwright-version: unable to detect versions, skipping.');
    process.exit(0);
}

if (playwrightFromTag !== playwrightFromPkg) {
    console.error(
        `Playwright version mismatch: base image tag has ${playwrightFromTag}, but package.json has ${playwrightDep}. ` +
            'Update the Docker base image tag or the package.json dependency to match.',
    );
    process.exit(1);
}

console.log(`check-playwright-version: OK (Playwright ${playwrightFromPkg})`);
