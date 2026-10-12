/**
 * Order & Job Tracking lists – one definition for the API (lists, counts, exports) and the UI (tables).
 * Every figure is derived from the actual records (orders, bookings, production entries, shipments,
 * invoices, payments); nothing here is typed in as a summary.
 *
 * Column types: text (default) · num · date · status · job (opens Job 360) · money · badge
 */
const c = (key, label, type = 'text') => ({ key, label, type });

/** Where an open job is waiting – in production-flow order – and who has to act. */
export const PENDING_STAGES = [
  { key: 'po', label: 'Awaiting confirmed PO', department: 'Head Office Merchandising' },
  { key: 'fabric', label: 'Awaiting fabric', department: 'Fabric Department' },
  { key: 'preproduction', label: 'Pre-production', department: 'Factory Merchandising' },
  { key: 'cutting', label: 'Cutting', department: 'Cutting' },
  { key: 'sewing', label: 'Sewing', department: 'Sewing' },
  { key: 'finishing', label: 'Finishing', department: 'Finishing' },
  { key: 'packing', label: 'Packing', department: 'Packing' },
  { key: 'quality', label: 'Quality approval', department: 'Quality' },
  { key: 'shipment', label: 'Shipment', department: 'Shipment / Documentation' },
  { key: 'accounts', label: 'Accounts / payment', department: 'Accounts & Finance' },
  { key: 'closure', label: 'Closure', department: 'Admin' },
];
/** Stages at which a job is still "unfinished" (production not complete). */
export const UNFINISHED_STAGES = ['po', 'fabric', 'preproduction', 'cutting', 'sewing', 'finishing', 'packing', 'quality'];

const ORDER = [c('unitName', 'Unit'), c('buyerName', 'Buyer'), c('refNo', 'Order No'), c('poNo', 'PO No'), c('styleNo', 'Style'), c('garment', 'Garment'), c('orderType', 'Type'),
  c('orderQty', 'Order Qty', 'num'), c('orderDate', 'Order Date', 'date'), c('deliveryDate', 'Delivery', 'date'), c('status', 'Order Status', 'status'), c('jobCreation', 'Job Creation'), c('jobNo', 'Assigned Job No', 'job')];
const FORECAST = [c('unitName', 'Unit'), c('buyerName', 'Buyer'), c('repeatOfJobNo', 'Previous Job', 'job'), c('previousPoNo', 'Previous PO'), c('styleNo', 'Style'), c('garment', 'Product'),
  c('previousQty', 'Previous Qty', 'num'), c('expectedOrderMonth', 'Expected Order Month'), c('forecastQty', 'Forecast Qty', 'num'), c('deliveryDate', 'Expected Delivery', 'date'),
  c('jobNo', 'Advance / Main Job', 'job'), c('subJobs', 'Sub Jobs'), c('forecastStatus', 'Forecast Status', 'badge'), c('poStatusText', 'Actual PO')];
const PENDING = [c('unitName', 'Unit'), c('buyerName', 'Buyer'), c('mainJobNo', 'Job No', 'job'), c('subJobNo', 'Sub Job', 'job'), c('styleNo', 'Style'), c('poNo', 'PO No'), c('orderQty', 'Order Qty', 'num'),
  c('poStatus', 'PO Status', 'badge'), c('fabricStatus', 'Fabric Booking'), c('fabricReceived', 'Fabric Rcvd', 'num'), c('fabricIssued', 'Fabric Issued', 'num'), c('fabricUnit', 'Unit'),
  c('cuttingStatus', 'Cutting', 'status'), c('sewingStatus', 'Sewing', 'status'), c('finishingStatus', 'Finishing', 'status'), c('packingStatus', 'Packing', 'status'),
  c('pendingQty', 'Pending Qty', 'num'), c('pendingStageLabel', 'Current Stage', 'badge'), c('pendingReason', 'Pending Reason'), c('deliveryDate', 'Delivery', 'date'), c('delayStatus', 'Delay', 'badge'), c('responsibleDept', 'Responsible')];
const FINISHED = [c('unitName', 'Unit'), c('buyerName', 'Buyer'), c('mainJobNo', 'Job No', 'job'), c('subJobNo', 'Sub Job', 'job'), c('poNo', 'PO No'), c('styleNo', 'Style'), c('orderQty', 'Ordered', 'num'),
  c('finishedQty', 'Production Done', 'num'), c('qcApprovedQty', 'QC Approved', 'num'), c('packedQty', 'Packed', 'num'), c('cartons', 'Cartons', 'num'), c('shippedQty', 'Shipped', 'num'),
  c('balanceToShip', 'Balance to Ship', 'num'), c('packState', 'Packing', 'badge'), c('shipmentBooking', 'Shipment Booking', 'badge'), c('invoiceStatus', 'Invoice', 'badge'),
  c('fgLocation', 'FG Location'), c('plannedShipDate', 'Planned Shipment', 'date'), c('deliveryDate', 'Buyer Delivery', 'date'), c('daysPendingShipment', 'Days Pending', 'num'),
  c('delayStatus', 'Delay', 'badge'), c('delayReason', 'Delay Reason')];
const PO_PENDING = [c('unitName', 'Unit'), c('buyerName', 'Buyer'), c('jobNo', 'Job / Sub Job', 'job'), c('refNo', 'Booking'), c('poType', 'Type'), c('item', 'Item'), c('supplierName', 'Supplier'),
  c('supplierPoNo', 'Supplier PO'), c('bookedQty', 'Ordered', 'num'), c('receivedQty', 'Received', 'num'), c('pendingQty', 'Pending', 'num'), c('uom', 'UoM'),
  c('dueDate', 'Due', 'date'), c('delayStatus', 'Delay', 'badge'), c('status', 'Status', 'status'), c('responsibleDept', 'Responsible')];
const HOLD = PENDING.map((x) => (x.key === 'pendingReason' ? c('holdReason', 'Hold / Block Reason') : x));
const SHIPPED = [c('unitName', 'Unit'), c('buyerName', 'Buyer'), c('mainJobNo', 'Job No', 'job'), c('subJobNo', 'Sub Job', 'job'), c('poNo', 'PO No'), c('styleNo', 'Style'), c('orderQty', 'Ordered', 'num'),
  c('packedQty', 'Packed', 'num'), c('shippedQty', 'Shipped', 'num'), c('balanceToShip', 'Balance', 'num'), c('lastShipDate', 'Last Shipped', 'date'), c('invoiceStatus', 'Invoice', 'badge'),
  c('paymentStatus', 'Payment', 'badge'), c('status', 'Job Status', 'status')];
const CLOSURE = [c('unitName', 'Unit'), c('buyerName', 'Buyer'), c('mainJobNo', 'Main Job', 'job'), c('subJobNo', 'Sub Job', 'job'), c('poNo', 'PO No'), c('styleNo', 'Style'), c('orderQty', 'Ordered', 'num'),
  c('shippedQty', 'Shipped', 'num'), c('cost', 'Cost', 'money'), c('revenue', 'Revenue', 'money'), c('profit', 'Profit', 'money'), c('marginPct', 'Margin %', 'num'),
  c('status', 'Status', 'status'), c('closedAt', 'Closed On', 'date'), c('blockers', 'Pending Before Closure')];
const MAIN = [c('unitName', 'Unit'), c('buyerName', 'Buyer'), c('jobNo', 'Main Job', 'job'), c('styleNo', 'Style'), c('poNo', 'PO No'), c('subCount', 'Sub Jobs', 'num'), c('subClosed', 'Subs Closed', 'num'),
  c('orderQty', 'Ordered', 'num'), c('packedQty', 'Packed', 'num'), c('shippedQty', 'Shipped', 'num'), c('balanceToShip', 'Pending Shipment', 'num'), c('progressPct', 'Progress %', 'num'),
  c('cost', 'Cost', 'money'), c('revenue', 'Revenue', 'money'), c('profit', 'Profit', 'money'), c('poStatusText', 'Actual PO'), c('blockers', 'Pending Before Closure'), c('status', 'Status', 'status')];

/** Dashboard lists in display order: the 15 order / job / shipment / closure lists, then purchasing, holds and deadlines. */
export const TRACKING_LISTS = [
  { key: 'newOrders', title: 'New Orders', icon: 'Inbox', kind: 'order', columns: ORDER, desc: 'Every buyer PO received, with its job creation status and assigned Job No.' },
  { key: 'awaitingJob', title: 'Orders Awaiting Job Creation', icon: 'Hourglass', kind: 'order', columns: ORDER, desc: 'Buyer POs received but not yet converted into a job.' },
  { key: 'repeatOrders', title: 'Repeat Buyer Orders', icon: 'RefreshCcw', kind: 'forecast', columns: FORECAST, desc: 'Orders that repeat an earlier job of the same buyer / style.' },
  { key: 'forecastOrders', title: 'Forecast Orders', icon: 'CalendarClock', kind: 'forecast', columns: FORECAST, desc: 'Forecast / continuous main jobs and advance jobs. Forecast quantities are not confirmed orders, revenue or shipments.' },
  { key: 'advanceAwaitingPo', title: 'Advance Jobs Awaiting Actual PO', icon: 'FileWarning', kind: 'forecast', columns: FORECAST, desc: 'Jobs and sub jobs opened in advance – link the actual PO when it arrives.' },
  { key: 'pendingPo', title: 'Pending PO Jobs', icon: 'FileSignature', kind: 'job', columns: PENDING, desc: 'Open jobs whose next step is a confirmed buyer PO.' },
  { key: 'awaitingFabric', title: 'Jobs Awaiting Fabric', icon: 'Layers', kind: 'job', columns: PENDING, desc: 'Fabric received is below the requirement and cutting is not complete.' },
  { key: 'underProduction', title: 'Jobs Under Production', icon: 'Factory', kind: 'job', columns: PENDING, desc: 'Cutting has started and packing / quality approval is not complete.' },
  { key: 'unfinished', title: 'Unfinished Jobs', icon: 'ListTodo', kind: 'job', columns: PENDING, desc: 'Every open job whose production is not complete – awaiting PO, fabric, pre-production, production or quality.' },
  { key: 'finishedPendingShipment', title: 'Finished Goods Pending Shipment', icon: 'PackageCheck', kind: 'job', columns: FINISHED, desc: 'Production and finishing complete, shipment not complete. A job is shipped only by a posted shipment.' },
  { key: 'partiallyShipped', title: 'Partially Shipped Jobs', icon: 'Ship', kind: 'job', columns: SHIPPED, desc: 'Some quantity shipped, balance still to ship.' },
  { key: 'fullyShipped', title: 'Fully Shipped Jobs', icon: 'CheckCheck', kind: 'job', columns: SHIPPED, desc: 'Shipped quantity reached the order quantity (within the short-ship tolerance).' },
  { key: 'subJobsReadyForClosure', title: 'Sub Jobs Ready for Closure', icon: 'BadgeCheck', kind: 'job', columns: CLOSURE, desc: 'Sub jobs that meet every closure condition.' },
  { key: 'closedSubJobs', title: 'Closed Sub Jobs', icon: 'Lock', kind: 'job', columns: CLOSURE, desc: 'Sub jobs closed independently of their main job.' },
  { key: 'mainJobsPendingClosure', title: 'Main Jobs Pending Final Closure', icon: 'GitFork', kind: 'main', columns: MAIN, desc: 'A main job closes only when all its sub jobs and final controls are complete.' },
  // purchasing, holds and deadlines
  { key: 'poPendingReceipt', title: 'Purchase Orders Pending Receipt', icon: 'Truck', kind: 'po', columns: PO_PENDING, desc: 'Fabric and trim purchase orders booked with suppliers and not fully received.' },
  { key: 'notStarted', title: 'Jobs Not Yet Started', icon: 'Circle', kind: 'job', columns: PENDING, desc: 'Confirmed (PO-backed) jobs with no cutting yet – waiting for fabric or pre-production.' },
  { key: 'onHold', title: 'Jobs on Hold / Blocked', icon: 'AlertOctagon', kind: 'job', columns: HOLD, desc: 'On hold, or blocked by fabric, trims, quality, approval or capacity.' },
  { key: 'overdue', title: 'Overdue & Due Within 14 Days', icon: 'AlarmClock', kind: 'job', columns: PENDING, desc: 'Open jobs not fully shipped whose shipment date has passed or falls in the next 14 days.' },
  { key: 'awaitingClosure', title: 'Completed – Awaiting Final Inspection or Closure', icon: 'ClipboardCheck', kind: 'job', columns: PENDING, desc: 'Production complete; final inspection, shipment, accounts or the closing sign-off still open.' },
];
export const TRACKING_LIST = Object.fromEntries(TRACKING_LISTS.map((l) => [l.key, l]));
/** Main Job dashboard (all main jobs with their sub jobs) – shown beside the 15 lists. */
export const MAIN_JOB_COLUMNS = MAIN;
