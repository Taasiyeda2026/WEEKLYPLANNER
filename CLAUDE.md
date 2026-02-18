# CLAUDE.md — WEEKLYPLANNER

This file describes the project structure, conventions, and development workflows for AI assistants working on this codebase.

---

## Project Overview

**יומן פעילות** (Weekly Activity Planner) is a client-side Progressive Web App (PWA) for Hebrew-speaking educational organizations. Instructors log in with an employee ID and personal code to view their weekly schedule of school visits, programs, and meeting notes.

There is no backend server. All data comes from Excel files loaded at runtime in the browser.

---

## Tech Stack

| Layer | Technology |
|---|---|
| UI | Vanilla HTML5 / CSS3 / JavaScript (no framework) |
| Data | Excel (.xlsx) files parsed in-browser via XLSX.js v0.18.5 (CDN) |
| Auth | Client-side SHA-256 hashing via Web Crypto API |
| PWA | Service worker (`sw.js`) + `manifest.json` |
| Fonts | Google Fonts — "Inter" |
| Localization | Hebrew (`he-IL`), RTL layout |

No build step, no npm, no bundler. The app is a static site served directly.

---

## Repository Structure

```
WEEKLYPLANNER/
├── index.html            # Entire application — HTML, CSS, and JS all embedded
├── hash-generator.html   # Admin utility: generate SHA-256 hashes for codes
├── manifest.json         # PWA manifest (name, icons, display mode)
├── sw.js                 # Service worker — network-only, no caching
├── InstructorData.xlsx   # Employee credentials and schedule data
├── ProgramRules.xlsx     # Per-program meeting notes (Reminder/Mandatory/Info)
├── GlobalMessages.xlsx   # System-wide announcements shown in activity popups
├── logo.png              # App logo (1024×1024 RGBA)
├── icon-192.png          # PWA icon (192×192)
└── icon-512.png          # PWA icon (512×512)
```

All application logic lives in `index.html`. There are no separate `.js` or `.css` source files.

---

## Data Model

### InstructorData.xlsx

One row per employee. Columns:

| Column | Description |
|---|---|
| `EmployeeID` | Numeric ID used as login username |
| `Employee` | Full name (Hebrew) |
| `Code` | SHA-256 hash of the personal code |
| `Date1`–`Date16` | Activity dates (up to 16 per employee) |
| `StartTime1`–`EndTime16` | Start/end times for each activity |
| `Manager1`–`Manager16` | Coordinator name |
| `School1`–`School16` | School/institution name |
| `Class1`–`Class16` | Class or grade |
| `Authority1`–`Authority16` | Educational authority/district |
| `Program1`–`Program16` | Program name |
| `Cancel1`–`Cancel16` | Cancellation date, if applicable |

Excel files **must** be parsed with `cellDates: true` to correctly interpret date cells.

### ProgramRules.xlsx

Maps program + meeting number to notes. Note types: `Reminder`, `Mandatory`, `Info`.

### GlobalMessages.xlsx

List of announcements shown at the top of every activity popup. Each row has a message type (`Info`, `Reminder`, `Mandatory`) and text.

---

## Authentication Flow

1. User enters Employee ID (numeric) and personal code.
2. Browser computes SHA-256 of the personal code using the Web Crypto API.
3. The hash is compared against the `Code` column in `InstructorData.xlsx`.
4. On match, the employee's row is stored in memory; the login view is replaced by the app view.
5. No token, no cookie, no server call — authentication is entirely in-browser.

**Security rules:**
- Never store plaintext codes anywhere — always SHA-256 hash them.
- When adding a new employee, use `hash-generator.html` to produce the hash, then paste it into the Excel file.
- Do not expose `hash-generator.html` publicly in a production deployment.
- Excel files are currently fetched without authentication — they are readable by anyone who knows the URL.

---

## UI Architecture

The UI has two states toggled by CSS `display`:

- **Login view** — `#loginSection`: employee ID + code inputs, login button.
- **App view** — `#appSection`: weekly calendar grid + navigation + popup modal.

Key DOM structures:
- `.week-grid` — 7 columns (Sun–Sat) rendered by `renderWeek(date)`.
- `.activity-card` — one per activity on a given day; click opens the popup.
- `.popup-overlay` — full-screen modal showing global messages and per-activity details.

### Program Colors

Programs are color-coded via a hardcoded `programColors` object in `index.html`. Unknown programs fall back to `#f1f5ff`. When adding a new program, add an entry to this mapping.

### Holiday Detection

Holidays are a hardcoded array of `{ date: "DD/MM/YYYY", name: "..." }` objects. Days matching a holiday receive special styling and display the holiday name.

---

## Key JavaScript Functions (in index.html)

| Function | Purpose |
|---|---|
| `hashCode(code)` | SHA-256 hashes a string using Web Crypto API |
| `loadExcelFiles()` | Fetches and parses all three Excel files via XLSX.js |
| `login()` | Validates credentials and transitions to app view |
| `renderWeek(date)` | Builds the 7-day calendar grid for a given week |
| `openPopup(date)` | Shows the activity detail modal for a clicked day |
| `getWeekDates(date)` | Returns array of 7 Date objects for the week containing `date` |

---

## Development Workflow

### Making Changes

1. Edit `index.html` directly — all HTML, CSS, and JS are embedded in this single file.
2. Open the file in a browser (or serve with a local static file server) to test.
3. Excel data files must be in the **same directory** as `index.html` for fetch paths to resolve.

### Serving Locally

Any static file server works:

```bash
# Python 3
python3 -m http.server 8080

# Node (if npx available)
npx serve .
```

Then open `http://localhost:8080` in a browser.

> Note: The browser may block `fetch()` requests for local `file://` URLs due to CORS. Always use a local server.

### Adding a New Employee

1. Open `hash-generator.html` in a browser.
2. Enter the employee's personal code and copy the resulting SHA-256 hash.
3. Add a new row to `InstructorData.xlsx` with the employee's details and hashed code.
4. Save and redeploy the Excel file.

### Adding a New Program

1. Add the program's entries to `ProgramRules.xlsx` (one row per meeting number).
2. Add a color entry to the `programColors` object in `index.html`:
   ```js
   "Program Name": "#rrggbb",
   ```

### Adding a Holiday

Add an entry to the `holidays` array in `index.html`:
```js
{ date: "DD/MM/YYYY", name: "שם החג" }
```

---

## Coding Conventions

### HTML / CSS

- All styles are inline in `<style>` within `index.html`. Do not create separate `.css` files.
- Use BEM-inspired class names: `.login-card`, `.popup-overlay`, `.activity-card`.
- CSS custom properties (`--primary-color`, etc.) are used for theming. Prefer these over hardcoded color values.
- The root element has `dir="rtl"` — all layout must remain RTL-compatible.

### JavaScript

- All script is embedded in a single `<script>` block at the bottom of `index.html`.
- Use `async/await` for all asynchronous operations (file loading, crypto).
- Constants are `UPPER_SNAKE_CASE`: `EXCEL_FILE`, `PROGRAM_RULES_FILE`, etc.
- Avoid introducing external dependencies. XLSX.js is loaded from CDN and is the only third-party library.
- Comments may be in Hebrew or English; match the style of surrounding code.

### Localization

- All user-facing text is in Hebrew.
- Use `toLocaleDateString('he-IL', ...)` for date formatting.
- Date format in data lookups is `DD/MM/YYYY`.

---

## No Tests, No CI

There is currently no automated test suite and no CI/CD pipeline. Validation is done manually by loading the app in a browser.

If tests are added in the future, they should be able to run without a network connection (mock the Excel fetch calls).

---

## Security Checklist for AI Assistants

When modifying this codebase:

- [ ] Never write plaintext passwords or codes into any file.
- [ ] Never modify the SHA-256 hashing logic in a way that weakens it.
- [ ] Do not add server-side endpoints that expose the Excel data files without authentication.
- [ ] Do not commit real employee data or personal codes to the repository.
- [ ] Keep `hash-generator.html` as a standalone utility — do not integrate it into the main app.

---

## Git Conventions

- Branch names follow the pattern: `claude/<description>-<session-id>`.
- Commit messages are in English, imperative style: `Fix empty calendar by parsing Excel dates with cellDates:true`.
- Use pull requests to merge feature branches; do not push directly to `main`.
