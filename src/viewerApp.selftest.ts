/**
 * The viewer page's renderer wiring: which script it loads, that the diagram goes through the shared
 * sanitizer, and that its inline script parses. The page is JS inside a TS template literal, so a
 * backslash lost in that layer yields code only a browser would reject; parsing it here catches that.
 * Drawing, export and pan/zoom are browser-only (verified in a browser).
 * Run: `pnpm test:viewer`.
 */
import { peleScriptTag, svgSanitizerScript, letterPrintScript } from '@dszp/netsapiens-lib';
import { viewerHtml } from './viewerApp.js';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n)); };

const html = viewerHtml();

ok('loads the lib\'s pinned Pele tag (exact version + SRI)', html.includes(peleScriptTag()) && /integrity="sha384-/.test(peleScriptTag()));
ok('loads no Mermaid script', !/<script[^>]*mermaid/i.test(html));
ok('loads no ELK plugin (an import that could carry no SRI)', !/layout-elk|\+esm/.test(html));
ok('injects the lib\'s SVG sanitizer', html.includes(svgSanitizerScript()));
ok('the diagram is inserted through cleanSvg(), not innerHTML', /replaceChildren\(cleanSvg\(pele\.render\(/.test(html) && !/\$\('diagram'\)\.innerHTML\s*=/.test(html));
ok('Pele\'s colors follow the theme', html.includes("'--pele-bg'") && html.includes("'--pele-line'"));
ok('click-to-navigate targets Pele\'s nodes', html.includes("querySelectorAll('g.pele-node')") && html.includes("getAttribute('data-id')"));

ok('injects the lib\'s Letter print layout and wires the PDF button to it', html.includes(letterPrintScript()) && html.includes('cfLetterPrint(') && html.includes("$('pdf').onclick=()=>window.print()"));

const themes = JSON.parse(/const THEMES = (\{.*?\});\n/s.exec(html)?.[1].replace(/\\u003c/g, '<') ?? '{}') as Record<string, { look: string }>;
ok('offers themes', Object.keys(themes).length >= 2);
ok('offers no hand-drawn theme (Pele cannot draw that style)', Object.values(themes).every((t) => t.look !== 'handDrawn'));

const inline = [...html.matchAll(/<script(?: type="module")?>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
ok('has an inline script to check', inline.length >= 1);
inline.forEach((body, i) => ok(`inline script ${i + 1} parses`, (() => { try { new Function(body); return true; } catch { return false; } })()));

console.log(`\nviewerApp.selftest: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
