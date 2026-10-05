# in-ctrl

Docs you stay in control of.

![A deployment drawn by in-ctrl: customers reach a Cloud Run API through Identity-Aware Proxy; it keeps orders in Cloud SQL](test/fixture/docs/diagrams/deployment.png)

AI can write a lot of code quickly. Staying in control means knowing what the code does: how the parts fit, what flows through them, where it runs. in-ctrl keeps that knowledge in your repository, as plain Markdown and small YAML diagrams that you review and change with the code, and makes it pleasant to read:

- **Diagrams from YAML:** architecture, deployment, flowcharts, lifecycles, tables (laid out by ELK, drawn with React Flow) and sequence diagrams, with real product icons (Google Cloud, Cloudflare, Docker, …), in light and dark.
- **Readable everywhere:** each diagram is also rendered to a PNG next to its source, which the Markdown embeds, so the docs read on GitHub and in any editor.
- **A docs site:** your `docs/` folder as a site with navigation, search and dark mode (Astro Starlight), where diagrams are live: zoom, pan, hover to follow a line, click a box to open its page.
- **Checks:** `in-ctrl check` fails when a PNG is older than its YAML, a diagram isn't shown anywhere, or an icon doesn't exist, without a browser, so it runs anywhere CI does.

## Use it

```bash
npm install --save-dev in-ctrl      # or: pnpm add -D in-ctrl
npx playwright install chromium     # once, for rendering PNGs

npx in-ctrl render                  # draw the diagrams that changed into their PNGs
npx in-ctrl check                   # are the PNGs current?
npx in-ctrl dev                     # every diagram, light and dark, in the browser
npx in-ctrl site dev                # the docs site, live
npx in-ctrl site build dist-docs    # the docs site, for hosting
```

Settings live in `in-ctrl.config.yaml` at the project root:

```yaml
title: Shop
description: How the shop works.
docs: docs                       # the Markdown folder
home: README.md                  # the site's front page
repo: https://github.com/you/shop
site:
  url: https://you.github.io
  base: /shop/
  sidebar: [guide, design, { dir: dev, label: Developer docs }]
vocabulary:                      # names every diagram draws the same way
  API: { label: Shop API, icon: "gcp:cloud-run" }
  DB: { label: Orders database, icon: "gcp:cloud-sql" }
```

The site takes your Markdown as it is: the first `# Heading` is the page title, `README.md` is a folder's page, links between docs become site links, and links to code go to GitHub.

### Sidebar

`sidebar` lists the top-level docs folders in order (the rest follow A to Z). A folder listed by name or as `{ dir, label }` is listed A to Z inside. Give it `items` or `order` to name and order what's inside it too:

```yaml
site:
  sidebar:
    - guide
    - dir: handbook
      label: Handbook
      items:                       # sub-folders in this order; the rest follow A to Z
        - { dir: guides, label: Guides }
        - reference                # labelled "Reference"
        - { dir: articles, label: Reports, order: newest-first, collapsed: true }
```

`order` is `az` (the default) or `newest-first` (Z to A by file name, for dated reports); a folder's own page always comes first.

### Reading width

The header has buttons that hide the sidebar and the table of contents (`[` and `]` from the keyboard); the page keeps the reader's choice. The content column starts next to the sidebar and widens to the whole page when both are hidden.

## Publish the site on GitHub Pages

In the repository's settings, set Pages to deploy from GitHub Actions, then add:

```yaml
# .github/workflows/docs.yml
name: Docs
on:
  push:
    branches: [main]
    paths: ["docs/**", "README.md", "in-ctrl.config.yaml"]
  workflow_dispatch:
jobs:
  docs:
    uses: gajop/in-ctrl/.github/workflows/pages.yml@v0.1.0
    permissions:
      contents: read
      pages: write
      id-token: write
```

It uses only GitHub's own token: no secrets, nothing deployed anywhere else.

## Graphs

```yaml
title: The shop on one machine
direction: RIGHT                 # or DOWN
nodes:
  - { id: machine, label: Your machine, icon: "lucide:laptop", kind: boundary }
  - { id: api, in: machine, is: API, detail: "serves the web shop" }
  - { id: db, in: machine, label: SQLite, icon: "devicon:sqlite", tags: [one file] }
  - { id: ready, shape: decision, label: "Every dependency\nended?" }
  - { id: ok, shape: state, label: success, tone: good }
edges:
  - { from: api, to: db, label: "reads, writes" }   # style: dashed, both: true
```

Node fields:

- `id`, and `label` (`\n` breaks the line). `detail` is a smaller second line.
- `is`: a name from the project's vocabulary (`vocabulary:` in `in-ctrl.config.yaml`). It gives the label and icon, so the same thing looks the same in every diagram. `label` and `icon` override it.
- `icon`: `gcp:*` and `cloudflare:*` from [icons/](icons/), or any icon of the `logos`, `devicon` and `lucide` sets on [Iconify](https://icon-sets.iconify.design/).
- `in`: the box this node sits in. A node with `kind: boundary` (an account, project or machine; dashed) or `kind: process` (one running program; solid), or one that others are `in`, is a box around them.
- `shape`:
  - `box`, the default: icon, label, detail and tags
  - `decision`: a diamond, for a question with labelled answers on its edges
  - `state`: a status, as a pill; with `tone: good | bad | quiet | accent` for results
  - `start`, `end`: the dots of a lifecycle
  - `entity`: a table, with `fields: ["name text UK", …]`
  - `note`: a dashed box of text
- `tags`: short facts as pills ("1 instance", "scales to zero").
- `link`: a relative doc link the guide follows when the node is clicked.

Edges: `from`, `to`, `label`, `style: dashed` (polling, background or optional), `both: true` (arrowheads at both ends), `main: true` (the main path: kept straight; a decision's main answer leaves from its front tip and the others from its side). Long labels wrap by themselves.

Layout tips:

- Nodes and edges are laid out in the order they are written. Write the main path first; a later edge that goes back (a retry, a resume) is drawn pointing back.
- In a chain of questions, mark the main path `main: true` and give each question its own outcome box (two `failed` boxes are fine), so every answer is a short arrow to the side.
- Lifecycles and wide flows read best left to right; architecture and deployment maps often fit the page better top-down (`direction: DOWN`).
- Don't nest boxes in lifecycles: an edge into or out of a box gets kinks. Say "from any unfinished state" in a label instead.
- Keep a diagram to about 12 nodes. Split bigger ones into an overview whose boxes `link` to one diagram per part.

## Sequences

```yaml
type: sequence
title: Placing an order
participants:
  - { id: api, is: API }
  - { id: db, is: DB }
  - { id: pay, label: Payments, icon: "lucide:credit-card" }
steps:
  - { from: api, to: db, label: is it in stock? }
  - { from: db, to: api, label: "yes, 3 left", kind: return }
  - loop: until the payment settles
    steps:
      - { from: api, to: pay, label: charge the card }
      - { from: pay, to: api, label: pending, kind: async }
  - alt:
      - when: paid
        steps:
          - { from: api, to: db, label: store the order }
      - when: declined
        steps:
          - { from: api, to: db, label: release the stock }
  - { note: "The customer sees the result.", over: [api, db] }
```

- Participants take `is`, `label` and `icon` like graph nodes.
- Message `kind`: `call` (solid, the default), `return` (dashed), `async` (open arrowhead: a report over a channel). `from` equal to `to` is a step a participant takes on its own.
- Frames: `alt` and `par` take a list of `{ when, steps }`; `opt` and `loop` take a label and `steps`. `phase: Name` with `steps` is a tinted band across the diagram, for the phases of a long flow.
- `note` with `over: one id` or `over: [first, last]`.
- Keep a sequence to about 12 messages and one level of frames inside frames.
