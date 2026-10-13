# StitchFlow ERP — Garment Order → Shipment Management (MERN)

An integrated garment ERP: **Buyer Enquiry → Costing → Quotation → Order → Specification → BOM → CAD → Pattern → Grading → Marker → T&A → PP Meeting → Fabric/Trim Booking → Sampling → Approval → Production Planning → Cutting → Sewing → Finishing → Packing → Final Inspection → Shipment → Buyer Documentation → Accounts → Payment → Profit Analysis → Job Close**, all tied to one **Job No** – run as **one website with two business units**: Unit-1 (`U1-1000`, `U1-1001`…) and Unit-2 (`U2-3000`, `U2-3001`…).

## Quick start

Requirements: Node 20+ and MongoDB running locally (`mongodb://127.0.0.1:27017`).

```bash
npm run install:all          # server + client dependencies
cp server/.env.example server/.env   # then set secrets & initial admin (already done locally)
npm run dev                  # API (http://localhost:5050) + UI (http://localhost:5173) together
# or separately: npm run dev:server / npm run dev:client
npm run seed:demo            # optional – demo buyers, jobs at every stage (skips if jobs exist)
```

Production: `npm run build` then `npm start`. The API serves `client/dist` on the same port.

### First login
The initial administrator is created **from `server/.env`** (`ADMIN_EMAIL` / `ADMIN_PASSWORD`) the first time the API starts with no admin. Credentials never appear in frontend code. The password is bcrypt-hashed, and a **password change is forced on first login**. After that, remove `ADMIN_PASSWORD` from `.env` if you like; it is only used for bootstrapping.

## Architecture

```
shared/                 ← single source of truth used by BOTH server and client
  constants.js          statuses, actions, departments, lifecycle stages, document types
  calc.js               calculation engine (fabric, trims, costing, efficiency, AQL, packing, profit, T&A)
  modules/*.js          module definitions: fields, status flows, prefill-from-job, compute()
  framework.js          department responsibility framework
server/src/
  modules/builder.js    builds Mongoose models from module definitions (+ job link, status, soft delete, audit fields)
  modules/crudRouter.js generic permission-enforced CRUD/status/export/delete/restore router per module
  modules/hooks.js      business rules: quantity guards, data pull (packing→shipment→invoice), alerts, syncs
  services/orderFlow.js order confirmation automation, quotation→order, forecast sub jobs, change impact
  services/lifecycle.js workflow engine: stage states, next process, progress, closure readiness, profit
  services/scheduler.js periodic role-based alerts (T&A delay, shortages, shipment/payment due…)
  routes/               auth, jobs (control tower/closure), dashboard, reports, documents, admin, search…
client/src/
  components/           FormRenderer (renders any module from its definition, live calc), RecordDrawer, DataTable…
  pages/                Dashboard, Department dashboards, Control Tower, ModulePage, Reports, Profit, Admin…
```

Because forms, validation and calculations come from `shared/`, adding a module means adding one definition file entry. The API, form, list, export and reports follow automatically.

## Key behaviours
- **Two units, one ERP:** login is two-step – credentials, then *Select Unit*. Every request runs in the selected unit: a Mongoose plugin (`server/src/services/unitContext.js`) adds the unit to every query and stamps it on every new record, so Unit-1 and Unit-2 jobs, production, fabric, CAD, quality, shipments, accounts, documents, notifications and audit never mix. Buyers, suppliers and master data are shared. Each unit has its own job number series (Settings → Units & job numbering; series only move forward). Admin reaches both units and can switch; other users see only their assigned units. Reports, dashboard and audit can show the current unit, the other unit, or both units consolidated (multi-unit users only). Data created before units existed is assigned to Unit-1 on startup.
- **Order confirmation** (direct or from an approved quotation) generates the Job No, T&A calendar, fabric requirement, trim bookings, PP meeting, sample tasks and a production plan draft.
- **Management analytics** (`/analytics`, `server/src/services/analytics.js`): Revenue (issued invoices) → COGS (invoiced qty × job cost of goods per piece) → operating expenses → **EBITDA** → interest, taxes, depreciation, amortization → net profit; inventory valued at any date by category (dated **stock ledger** for fabric / trims / accessories / packing, yarn & grey chain, WIP and finished goods from dated production entries) → opening / closing / average → **ITR** = COGS ÷ average inventory and **holding days**; **ROI** by product, style, buyer, job, PO, colour, order or unit; cost variance by garment cost head (`shared/costHeads.js`); fabric, production and shipment performance. Unit and period aware; every figure drills down to its Job No and source records. Admin by default, others need the *Management Analytics* permission. Company-level expenses (interest, tax, depreciation, amortization, admin) are recorded in Expenses without a Job No.
- **Fabric by lot and roll:** Fabric Receipt records each roll (lot, shade, width, GSM, qty, 4-point points; over 40 points / 100 sq yd fails) against a booking or forecast; Fabric Allocation reserves passed rolls for cutting (*Allocated* – held in store, shown as reserved / free stock, blocks closure until issued or cancelled) and issues them (*Issued to Cutting*). Once a booking has receipts / allocations, its received, inspected, approved and issued quantities, its stock ledger and its BOM line (planned → required → issued → consumed → balance) follow the rolls.
- **Finishing & QC:** finishing entries record ironing and needle detection; metal-detected pieces must be rejected or reworked and only detector-cleared pieces pass. In-line, end-line and final inspections are evaluated by AQL.
- **Job types & revisions:** Main Job, Forecast / Continuous Job, Sub Job, Transfer Sub Job; changes to quantity, price, dates, PO or breakdown after confirmation raise the order revision with a log.
- **Closure:** Fabric and Profitability are mandatory closure stages by default (with cutting, sewing, quality, finishing, packing, shipment, documents, accounts, payment); the Job Close Report shows unit, buyer, order, main / sub job, quantities, cost, revenue, profit, margin, accounts status, checklist, date and who closed it.
- **Pre-production chain:** confirmation also creates a Tech Spec and a BOM (lines linked to the generated bookings). The spec's measurement chart becomes the pattern's grade rules; pattern approval needs an approved spec, marker approval needs a graded pattern. Approving a BOM books any new line (e.g. rib fabric). Marker consumption is compared with the BOM and alerts Fabric/Costing; cutting picks the approved marker and pulls its lay data. Each step stamps its T&A activity and updates the PP meeting readiness.
- **No re-entry:** selecting a job pre-fills every form (fabric specs, quantities, prices). Shipments pull packing totals, invoices pull shipment quantity and order price, and quotations pull costing.
- **Change impact:** editing an order recalculates early-stage records and flags later-stage ones to the responsible department.
- **Fabric closure:** a booking becomes `READY TO CLOSE` (or `READY TO CLOSE / EXCESS BALANCE`) when booked, received, inspected and approved quantities cover the requirement and issue/consumption is done. Close requires `close` permission.
- **Forecast orders:** Admin splits a main job into `-F01…` sub jobs. Main job qty = sum of sub jobs, and each sub job has its own full lifecycle and closure.
- **Job closure:** `READY TO CLOSE` is computed from configurable closure stages, required documents, open samples, shortages and PPM actions. Closing early needs `override` and a reason (audited).
- **Error prevention:** duplicate Job/PO/invoice numbers, negative values, over-cutting, sewing > cut, finishing > sewn, packing > finished, shipment > order, payment > outstanding and stage skipping are all blocked unless an authorised user overrides with a reason.
- **RBAC:** 16 department roles with per-module View/Create/Edit/Delete/Approve/Export/Close/Override/Reports, plus per-user grants and revokes. Enforced in the API.
- **Audit trail:** every create, update (old → new per field), status change, override, delete, restore, export and login, with user, IP and device.
- **Soft delete + Recycle Bin** for all business records (Admin restore).

## Factory operations – hourly production, quality, HR, factory costs and P&L

Everything below runs in both units, uses the same Main / Sub Job numbers (`U1-1000`, `U1-1000-S01`…) and is calculated from saved transactions only. Shared definitions: `shared/modules/factory.js`; rules: `server/src/modules/factoryHooks.js`; engines: `server/src/services/factoryFlow.js`, `costAllocation.js`, `factoryReports.js`; UI: **Factory Control Center** (`/factory`).

- **Hourly production (all 13 departments)** – one sheet per job, department, date, shift and line, one row per hour (target, input, completed, rejected, rework, downtime, delay reason, team, man-hours; each row stamped with who entered / changed it). Daily totals are the sum of the rows. Sewing and Ironing sheets are **consolidated automatically** into the daily Sewing / Finishing entries, so plans, Job 360, closure and analytics follow without re-entry (those consolidated entries are edited through their sheets).
- **Department flow** – Cutting → Cutting Issue → Preparation → Assembly → Sewing → Checking → Quality Control → Trimming & Alteration → Ironing → Folding → Packing → Carton → Finished Goods Inward. A department can only take in what the previous one completed (or, at a **quality gate**, what QC released); only cutting creates pieces, so nothing is counted twice. Routing per buyer / style / garment type with its own gates: *Production Routing & Quality Gates*. Default gates: Final Garment Inspection → Folding, Pre-shipment Inspection → Shipment. Production is booked on the sub job, never on a main job that has sub jobs.
- **Quality** – *QC Inspections* at 12 stages with checkpoints loaded from *QC Checkpoints* (by stage, buyer, style), AQL, defects (configurable Defect Type master + category, code, responsible department / line) and lot disposition: passed + rework + rejected + held = lot. *Rework & Corrective Action*: assign → rework → reinspection → close (approve permission, corrective action, nothing pending). Reworked pieces count as accepted only when reinspection passes them; release without rework needs the **Quality Release** permission and a reason (audited). Held goods never ship – shipping beyond quality-released finished goods is blocked.
- **HR & labour** – employee wage master (salary / daily wage, OT rate, employer contribution %, section), daily *Attendance & Labour* sheets per section (estimated cost; an employee once per day), *Payroll* per month built from attendance (actual cost; an employee once per month; no second run). Wages cannot also be booked as a job *Labour* expense once payroll is posted.
- **Factory expenses** – daily entry with approval, payment status, document reference, recurring monthly bills (one per payee / category / month), shared bills split between the units, duplicate prevention (payee + bill no).
- **Costing (documented rule)** – attendance hours booked to a job are direct labour; other section hours are allocated by that section's output per job; inspection sections are quality cost; indirect sections and factory expenses form the overhead pool, allocated by sewing output. Absorption is at **normal capacity** (Settings → Tolerances → *Labour & overhead absorption*): a slow month charges jobs only for the capacity used, the under-recovery is a period cost. Actual (payroll) and estimated (attendance before payroll) are shown separately; factory depreciation is a period cost. Every amount is allocated exactly once.
- **Reports** (`/factory`, CSV / Excel, unit / both-unit scope, date / buyer / job / style / department / line / shift / stage / inspector / defect filters, every row links to its source record): hourly, daily, shift, department, line, job, team, target vs actual, delays, monthly unit comparison; stage-wise WIP; full QC suite (daily / hourly / stage / department / job / buyer / style & size / inspector / unit / monthly, Pareto, defect register, repeated defects, holds, pending inspections, final and pre-shipment approval, CAPA status); finished goods pending shipment; labour & payroll; factory expenses; cost of quality (actual vs included vs estimated); job / sub job / unit / combined P&L by day, week or month with cash flow kept separate; Main / Sub Job history; **Integrity Checks** (19 reconciliations: hourly ↔ daily, flow, inspections, rework, holds, main / sub totals, duplicate wages / salaries / bills, allocation, units ↔ combined, closed jobs).
- **Edit reasons** – changing an approved sheet, inspection, quality issue, attendance, payroll or factory expense requires a reason, stored in the audit trail with the old → new values.
- **Closure** adds: no open quality issue or uninspected lot, no department WIP, nothing waiting between departments or at a quality gate.

## Security
bcrypt (12 rounds), short-lived JWT access tokens held in memory, rotating httpOnly refresh-token cookies (hashed in DB, reuse detection), forced password change, account lockout, login rate limiting, global rate limit, Helmet headers, CORS allow-list, Mongo operator sanitisation, upload type/size validation with random server-side file names, CSV formula-injection guard, backend permission checks on every route.

## Tests
`server/tests/e2e.mjs` exercises the full lifecycle, guards, RBAC, audit, reports and exports. **It changes the admin password, so run it only against a throwaway database:**

```bash
cd server
PORT=5051 ADMIN_PASSWORD=Admin@12345 MONGO_URI=mongodb://127.0.0.1:27017/garment_erp_test DISABLE_SCHEDULER=true node src/index.js &
node tests/e2e.mjs
node tests/factory.e2e.mjs   # factory operations – run after e2e.mjs on the same throwaway server
```

The sample data tool (`node src/scripts/sampleData.js --apply`, backup first, flagged sample records only) also builds hourly flow, QC with rework, attendance, payroll and factory expenses for both units, runs guard tests and the integrity checks.
