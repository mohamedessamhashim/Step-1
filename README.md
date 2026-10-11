# Step 1 planner

A personal USMLE Step 1 study planner that runs as a static website. It turns your qbank counts, First Aid chapters and ten self-assessments into a day-by-day plan up to the exam, and re-plans when you miss a day, take a day off or move the exam.

There is no server and no build step: plain HTML, CSS and JavaScript modules. Your data stays in your browser (and, if you turn sync on, in a gist on your own GitHub account).

## Run it locally

The page uses JavaScript modules, which browsers will not load from a `file://` address, so serve the folder:

```sh
cd "Step 1"
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Put it on GitHub Pages

1. Create a new repository on GitHub. On a free account it has to be public for Pages to work.
2. Push this folder to it:

   ```sh
   cd "Step 1"
   git init -b main
   git add .
   git commit -m "Step 1 planner"
   git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
   git push -u origin main
   ```

3. On GitHub, open the repository's **Settings → Pages**. Under **Build and deployment**, set **Source** to **Deploy from a branch**, choose **main** and **/ (root)**, and save.
4. After a minute the planner is at `https://YOUR-USERNAME.github.io/YOUR-REPO/`. On your phone, open it and use **Add to Home Screen**.

What is public: the code and the starting numbers in `data/seed.js`. What is not in the repository: your log, scores, settings, passcode and GitHub token. Those live only in the browser you use.

## Day to day

- **The day card** shows one day. Swipe, use the arrow keys, or use the buttons; **Today** jumps back. Tick tasks as you do them. For a qbank block, type how many you actually did (for example 25 of 40) and, if you like, the % correct.
- **Anki reviews** is the first task on every study day. It is optional: skipping it never counts against the day. Turn it off in Settings → Plan.
- **Behind plan.** If earlier days have unfinished questions, the planner asks what to do when you open it. Each choice shows the new exam date, daily loads and finish date before you apply it:
  - spread them over the coming days (never above the caps, 60 on weekdays and 100 at weekends by default);
  - push the exam by N days and keep the pace;
  - add them to the next weekends;
  - or leave the plan as it is, in which case they sit at the end.
- **Missed today / sick day** (on today's card) closes the day early and offers the same choices.
- **Days off.** Use "Mark as day off" on a card, or Settings → Days off for a range such as travel.
- **Undo.** Every rebalance, day off and exam-date change is listed in Settings → History. Undo reverts the most recent one, then the one before it, and so on.
- **Past days never change.** Only today and later are re-planned. You can still log a past day late.

## Updating your qbank counts

Open **Settings → Qbank**.

- Paste the text of your qbank dashboard (system names with their unused counts, in any layout) and press **Read the pasted text**. Check the numbers it found, then press **Update counts**.
- Or type new numbers straight into the list and press **Update counts**.

The plan is rebuilt from today with the new counts. Use this whenever the planner and the qbank disagree, for example after doing extra questions the planner did not know about.

## Sync between devices (optional)

Sync keeps one copy of your data in a secret gist on your GitHub account.

1. On GitHub: **Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic)**. Tick only the **gist** scope, set an expiry, and copy the token.
2. In the planner: **Settings → Data & sync**, paste the token, **Connect**.
3. Do the same on your other device. It finds the same gist and loads your data.

How it behaves:

- It loads the latest copy when the planner opens or comes back into view, and sends your changes a few seconds after you make them.
- **The newest edit wins.** If you change things on two devices while one is offline, the later edit replaces the earlier one. The replaced copy is kept on that device under Settings → Data & sync → Restore, and the gist keeps its own revision history on GitHub.
- The token is stored only in that browser. It is never written to the gist, the export file or this repository.
- A secret gist is not listed or searchable, but anyone who has its address can read it. Do not share the gist link.
- To stop: **Disconnect this device** in the planner, and delete the token on GitHub.

## Backup

**Settings → Data & sync → Export JSON** downloads everything as one file. **Import JSON** loads such a file and keeps the copy it replaced for Restore. The file never contains the token or the passcode.

## Passcode

Settings → Appearance & lock can ask for a passcode when the planner opens on that device.

**This is a convenience, not security.** It only keeps the page from opening at a glance. The data is stored unencrypted in the browser, and anyone who can use the browser can remove the lock. If you forget the passcode, open the browser console on the page and run `localStorage.removeItem('step1.lock')`, then reload.

## How the plan is built

- **Phases.** Working phase from the start date; dedicated for the last 14 days before the exam, the last of which is a rest day; then exam day.
- **Order of the day.** Anki reviews, then the question blocks, then reviewing incorrects and guessed corrects (2 to 4 hours), then First Aid.
- **Questions per day.** 40 on weekdays, 80 on weekend days from Sat Oct 17, 100 in dedicated, none on self-assessment days. Always in blocks of 40 or fewer.
- **Self-assessments.** Five on working-phase Saturdays, starting on the Saturday nearest the point where 40% of the unused questions are done; five in dedicated, three days apart, the last one two days before the exam. One that is not taken moves to the next slot.
- **First Aid.** One hour a day through the chapters in order. Pages per hour is worked out so every chapter finishes before dedicated. Chapters without page numbers are planned by hours until you enter pages. In dedicated it becomes a rapid review of your weakest chapters, ranked by the weak areas you pick after each self-assessment and by your block scores.
- **Blocks.** Before the first self-assessment, each block is "Timed · Unused" on the systems that match the day's First Aid chapter. When that chapter has no questions left, General Principles systems are used instead. After the first self-assessment, and all through dedicated, blocks are "Random · Timed · Unused". Once nothing is unused, they become "Timed · Incorrects".
- **Every unused question is planned exactly once.** The planner shows the projected finish date and flags it if it falls inside dedicated, and shows the earliest exam date your pace allows.

All of these numbers are in Settings.

## Changing the starting data

`data/seed.js` holds the starting counts, chapters and settings. It is read only the first time the planner opens in a browser; after that, change things in Settings. **Settings → Data & sync → Reset** reloads the seed.

## Tests

```sh
node --test
```

Needs Node 18 or later and installs nothing. The tests cover the planning rules: totals are conserved, no block is over 40, no day is over its cap, self-assessment days have no qbank blocks, rebalancing conserves totals and never schedules work on a day off, and past days never change.

## Files

| Path | What it holds |
|---|---|
| `index.html`, `styles.css` | The page and its styles (light and dark) |
| `data/seed.js` | Starting data |
| `js/planner.js` | The planning engine |
| `js/rebalance.js` | Missed days and the rebalance options |
| `js/model.js` | The state and every change to it |
| `js/parse.js` | Reading pasted dashboard text |
| `js/storage.js`, `js/sync.js` | Saving, export and import, gist sync |
| `js/app.js`, `js/ui/` | Start-up and the interface |
| `tests/` | Unit tests |
| `package.json` | Only tells Node the files are modules; there are no dependencies |
| `.nojekyll` | Tells GitHub Pages to serve the files as they are |

Fonts (Fraunces and DM Sans) load from Google Fonts. Without a connection the page falls back to system fonts.
