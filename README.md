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

## Security
bcrypt (12 rounds), short-lived JWT access tokens held in memory, rotating httpOnly refresh-token cookies (hashed in DB, reuse detection), forced password change, account lockout, login rate limiting, global rate limit, Helmet headers, CORS allow-list, Mongo operator sanitisation, upload type/size validation with random server-side file names, CSV formula-injection guard, backend permission checks on every route.

## Tests
`server/tests/e2e.mjs` exercises the full lifecycle, guards, RBAC, audit, reports and exports. **It changes the admin password, so run it only against a throwaway database:**

```bash
cd server
PORT=5051 ADMIN_PASSWORD=Admin@12345 MONGO_URI=mongodb://127.0.0.1:27017/garment_erp_test DISABLE_SCHEDULER=true node src/index.js &
node tests/e2e.mjs
```
