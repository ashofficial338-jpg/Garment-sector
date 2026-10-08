/** Sidebar navigation. `perm` = [module, action] required to see the entry. */
export const NAV = [
  { group: 'Overview', items: [
    { to: '/', label: 'Dashboard', icon: 'LayoutDashboard', perm: ['dashboard'] },
    { to: '/control-tower', label: 'Job 360 / Control Tower', icon: 'RadioTower', perm: ['jobs'] },
    { to: '/my-dashboard', label: 'Department Dashboard', icon: 'Gauge', perm: ['dashboard'] },
  ] },
  { group: 'Merchandising', items: [
    { to: '/m/enquiry', label: 'Buyer Enquiries', icon: 'MessageSquareText', perm: ['enquiry'] },
    { to: '/m/costing', label: 'Costing', icon: 'Calculator', perm: ['costing'] },
    { to: '/m/quotation', label: 'Quotations', icon: 'FileSignature', perm: ['quotation'] },
    { to: '/m/orders', label: 'Orders / Jobs', icon: 'ClipboardCheck', perm: ['orders'] },
  ] },
  { group: 'Pre-Production', items: [
    { to: '/m/techSpec', label: 'Specifications', icon: 'FileCog', perm: ['techSpec'] },
    { to: '/m/bom', label: 'Bill of Materials', icon: 'ListTree', perm: ['bom'] },
    { to: '/m/pattern', label: 'CAD, Pattern & Grading', icon: 'DraftingCompass', perm: ['pattern'] },
    { to: '/m/marker', label: 'Markers', icon: 'Ruler', perm: ['marker'] },
  ] },
  { group: 'Planning', items: [
    { to: '/m/tna', label: 'Time & Action', icon: 'CalendarClock', perm: ['tna'] },
    { to: '/m/ppMeeting', label: 'PP Meetings', icon: 'Users', perm: ['ppMeeting'] },
    { to: '/m/sample', label: 'Sampling & Approval', icon: 'Shirt', perm: ['sample'] },
  ] },
  { group: 'Materials', items: [
    { to: '/m/fabricBooking', label: 'Fabric Booking', icon: 'Layers', perm: ['fabricBooking'] },
    { to: '/m/trimBooking', label: 'Trim Booking', icon: 'Tag', perm: ['trimBooking'] },
  ] },
  { group: 'Fabric Stock', items: [
    { to: '/m/yarnReceipt', label: 'Yarn Inward', icon: 'Package', perm: ['yarnReceipt'] },
    { to: '/m/knitting', label: 'Knitting', icon: 'Waypoints', perm: ['knitting'] },
    { to: '/m/fabricProcess', label: 'Fabric Processing', icon: 'Droplets', perm: ['fabricProcess'] },
    { to: '/stock', label: 'Stock Reports', icon: 'Warehouse', perm: ['stock'] },
  ] },
  { group: 'Production', items: [
    { to: '/m/productionPlan', label: 'Production Planning', icon: 'GanttChartSquare', perm: ['productionPlan'] },
    { to: '/m/cutting', label: 'Cutting', icon: 'Scissors', perm: ['cutting'] },
    { to: '/m/sewing', label: 'Sewing', icon: 'Spline', perm: ['sewing'] },
    { to: '/m/finishing', label: 'Finishing', icon: 'Sparkles', perm: ['finishing'] },
    { to: '/m/packing', label: 'Packing', icon: 'PackageCheck', perm: ['packing'] },
    { to: '/m/inspection', label: 'Final Inspection', icon: 'ShieldCheck', perm: ['inspection'] },
  ] },
  { group: 'Shipping & Finance', items: [
    { to: '/m/shipment', label: 'Shipments', icon: 'Ship', perm: ['shipment'] },
    { to: '/documents', label: 'Buyer Documents', icon: 'FolderOpen', perm: ['documents'] },
    { to: '/m/invoice', label: 'Invoices / Accounts', icon: 'ReceiptText', perm: ['invoice'] },
    { to: '/m/payment', label: 'Payments', icon: 'Wallet', perm: ['payment'] },
    { to: '/m/expense', label: 'Expenses', icon: 'Coins', perm: ['expense'] },
    { to: '/profit', label: 'Profit Analysis', icon: 'TrendingUp', perm: ['profit'] },
  ] },
  { group: 'Insights', items: [
    { to: '/analytics', label: 'Management Analytics', icon: 'ChartNoAxesCombined', perm: ['analytics'] },
    { to: '/reports', label: 'Report Center', icon: 'FileBarChart', perm: ['reports'] },
    { to: '/notifications', label: 'Notifications', icon: 'Bell' },
    { to: '/framework', label: 'Department Framework', icon: 'BookOpenCheck' },
  ] },
  { group: 'Master Data & HR', items: [
    { to: '/m/buyer', label: 'Buyers', icon: 'Building2', perm: ['buyer'] },
    { to: '/m/supplier', label: 'Suppliers', icon: 'Truck', perm: ['supplier'] },
    { to: '/masters', label: 'Master Data', icon: 'Database', perm: ['master'] },
    { to: '/m/employee', label: 'Employees', icon: 'IdCard', perm: ['employee'] },
  ] },
  { group: 'Administration', items: [
    { to: '/admin/users', label: 'Users', icon: 'UserCog', perm: ['users'] },
    { to: '/admin/roles', label: 'Roles & Permissions', icon: 'KeyRound', perm: ['roles'] },
    { to: '/admin/settings', label: 'Workflow & Settings', icon: 'Workflow', perm: ['settings'] },
    { to: '/admin/audit', label: 'Audit Trail', icon: 'History', perm: ['audit'] },
    { to: '/admin/recycle-bin', label: 'Recycle Bin', icon: 'Trash2', admin: true },
  ] },
];
