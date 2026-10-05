/** `enigma design --help`. Its own module so the main help can show it without loading the extractor. */

import { AGENTS } from "@/agents";

export const DESIGN_HELP = `usage: enigma design <url|path|git-url> [options]
       enigma design --url <url> | --dir <path> | --repo <git-url> [options]
Reverse-engineer a design system into DESIGN.md and an agent skill: colors and their
roles, type scale, spacing grid, radii, shadows, breakpoints, motion, components.
Static analysis only - no model, no API key. A site is crawled over HTTP; when Chrome,
Edge, Chromium or Brave is installed it is also rendered headless for computed styles
and screenshots. Repository code is read, never executed.

Source (one; a bare argument is detected):
  --url <url>            crawl a live site (same-origin pages)
  --dir <path>           scan a local project
  --repo <git-url>       shallow-clone a repository and scan it

Output:
  --out <dir>            parent folder for <name>-design/ (default: current folder)
  --name <name>          project name (default: package.json name, repo or host name)
  --format <f>           both (default) | skill | design-md
  --no-skill             same as --format design-md
  --no-fonts             do not download font files into fonts/
  --bundle-site-fonts    also copy fonts the site self-hosts (check their license)
  --force                replace an output or skill folder enigma did not create

Browser (--url):
  --ultra                also capture scroll journey, page/section screenshots,
                         hover/focus states, keyframes, layout and DOM components
  --mode <m>             default | ultra (same as --ultra)
  --screens <n>          pages to capture in ultra mode, 1-20 (default 5)
  --browser <path>       browser executable (also ENIGMA_BROWSER / CHROME_PATH)
  --no-browser           HTTP crawl only: no rendered styles or screenshots

Install (the skill is copied into each detected agent's skills folder):
  -g, --global           user-level skills folder (default)
  -l, --local            this project's skills folder
  -a, --agent <list>     only these agents (${Object.keys(AGENTS).join(", ")})
  --no-install           write the files only

Examples:
  enigma design https://stripe.com --ultra
  enigma design ./apps/web --format design-md
  enigma design https://github.com/shadcn-ui/ui --no-install`;
