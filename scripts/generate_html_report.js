import fs from "fs";
import path from "path";

const data = JSON.parse(fs.readFileSync(path.join(process.cwd(), "partner_leads_analysis.json"), "utf8"));
const { totalLeads, registeredCount, remainingCount, conversionRate, leads } = data;

// Calculate unique counts
const uniquePhones = new Set();
const uniqueRemaining = [];
const uniqueRegistered = [];

leads.forEach(l => {
  const p = l.cleanPhone;
  if (!uniquePhones.has(p)) {
    uniquePhones.add(p);
    if (l.isRegistered) {
      uniqueRegistered.push(l);
    } else {
      uniqueRemaining.push(l);
    }
  }
});

// Count by city and state for remaining leads
const cityCount = {};
const stateCount = {};
uniqueRemaining.forEach(l => {
  const city = l.city || "Unknown";
  const state = l.state || "Unknown";
  cityCount[city] = (cityCount[city] || 0) + 1;
  stateCount[state] = (stateCount[state] || 0) + 1;
});

const topCities = Object.entries(cityCount).sort((a, b) => b[1] - a[1]).slice(0, 10);
const topStates = Object.entries(stateCount).sort((a, b) => b[1] - a[1]);

const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DhanSource Partner Leads - Registration Status Report</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #2563eb;
      --primary-dark: #1d4ed8;
      --primary-light: #dbeafe;
      --success: #16a34a;
      --success-light: #dcfce7;
      --warning: #ea580c;
      --warning-light: #ffedd5;
      --danger: #dc2626;
      --danger-light: #fee2e2;
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --text: #0f172a;
      --text-muted: #64748b;
      --border: #e2e8f0;
      --radius: 12px;
      --shadow: 0 4px 6px -1px rgb(0 0 0 / 0.07), 0 2px 4px -2px rgb(0 0 0 / 0.07);
      --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: 'Plus Jakarta Sans', sans-serif;
    }

    body {
      background-color: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 24px 16px;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
    }

    /* Header */
    .header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
      color: white;
      padding: 28px 32px;
      border-radius: var(--radius);
      box-shadow: var(--shadow-lg);
      margin-bottom: 24px;
    }

    .header-title h1 {
      font-size: 26px;
      font-weight: 800;
      letter-spacing: -0.5px;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .header-title p {
      color: #94a3b8;
      font-size: 14px;
      margin-top: 4px;
    }

    .header-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.2s ease;
      text-decoration: none;
    }

    .btn-primary {
      background-color: #3b82f6;
      color: white;
    }
    .btn-primary:hover {
      background-color: #2563eb;
      transform: translateY(-1px);
    }

    .btn-success {
      background-color: #10b981;
      color: white;
    }
    .btn-success:hover {
      background-color: #059669;
      transform: translateY(-1px);
    }

    .btn-outline {
      background: rgba(255, 255, 255, 0.1);
      color: white;
      border: 1px solid rgba(255, 255, 255, 0.2);
    }
    .btn-outline:hover {
      background: rgba(255, 255, 255, 0.2);
    }

    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 18px;
      margin-bottom: 24px;
    }

    .stat-card {
      background: var(--card-bg);
      padding: 20px 24px;
      border-radius: var(--radius);
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: relative;
      overflow: hidden;
    }

    .stat-card::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 4px;
    }

    .stat-card.blue::before { background-color: #3b82f6; }
    .stat-card.green::before { background-color: #10b981; }
    .stat-card.orange::before { background-color: #f97316; }
    .stat-card.purple::before { background-color: #8b5cf6; }

    .stat-info .stat-label {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .stat-info .stat-value {
      font-size: 30px;
      font-weight: 800;
      color: var(--text);
      margin-top: 4px;
    }

    .stat-info .stat-sub {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 2px;
    }

    .stat-icon {
      width: 52px;
      height: 52px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
    }

    .stat-card.blue .stat-icon { background: #eff6ff; color: #3b82f6; }
    .stat-card.green .stat-icon { background: #f0fdf4; color: #10b981; }
    .stat-card.orange .stat-icon { background: #fff7ed; color: #f97316; }
    .stat-card.purple .stat-icon { background: #f5f3ff; color: #8b5cf6; }

    /* Control Panel */
    .control-card {
      background: var(--card-bg);
      border-radius: var(--radius);
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
      padding: 20px 24px;
      margin-bottom: 24px;
    }

    .tabs-and-search {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
    }

    .tabs {
      display: flex;
      gap: 8px;
      background: #f1f5f9;
      padding: 4px;
      border-radius: 10px;
    }

    .tab-btn {
      padding: 8px 16px;
      border-radius: 8px;
      border: none;
      background: transparent;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .tab-btn.active {
      background: white;
      color: var(--primary);
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }

    .tab-badge {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 11px;
      margin-left: 6px;
    }
    .tab-btn.active .tab-badge {
      background: var(--primary-light);
      color: var(--primary);
    }
    .tab-btn:not(.active) .tab-badge {
      background: #e2e8f0;
      color: #64748b;
    }

    .filter-group {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      flex-grow: 1;
      justify-content: flex-end;
    }

    .search-box {
      position: relative;
      min-width: 260px;
    }

    .search-box input {
      width: 100%;
      padding: 9px 12px 9px 36px;
      border-radius: 8px;
      border: 1px solid var(--border);
      font-size: 13px;
      outline: none;
      transition: border-color 0.2s;
    }

    .search-box input:focus {
      border-color: var(--primary);
    }

    .search-icon {
      position: absolute;
      left: 12px;
      top: 50%;
      transform: translateY(-50%);
      color: #94a3b8;
      pointer-events: none;
    }

    .select-filter {
      padding: 9px 14px;
      border-radius: 8px;
      border: 1px solid var(--border);
      font-size: 13px;
      background: white;
      outline: none;
      cursor: pointer;
    }

    /* Table */
    .table-container {
      background: var(--card-bg);
      border-radius: var(--radius);
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 13px;
    }

    thead th {
      background: #f8fafc;
      padding: 14px 16px;
      font-weight: 700;
      color: #475569;
      border-bottom: 2px solid var(--border);
      white-space: nowrap;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.5px;
    }

    tbody tr {
      border-bottom: 1px solid var(--border);
      transition: background 0.15s;
    }

    tbody tr:hover {
      background: #f8fafc;
    }

    tbody td {
      padding: 14px 16px;
      vertical-align: middle;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }

    .badge-danger {
      background-color: var(--danger-light);
      color: var(--danger);
    }

    .badge-success {
      background-color: var(--success-light);
      color: var(--success);
    }

    .badge-platform {
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .badge-ig { background: #fdf2f8; color: #db2777; border: 1px solid #fbcfe8; }
    .badge-fb { background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; }

    .lead-name {
      font-weight: 700;
      color: var(--text);
      font-size: 14px;
    }

    .lead-phone {
      font-family: monospace;
      font-size: 13px;
      color: #334155;
      font-weight: 600;
    }

    .lead-location {
      display: flex;
      flex-direction: column;
    }
    .lead-city {
      font-weight: 600;
      color: var(--text);
    }
    .lead-state {
      font-size: 11px;
      color: var(--text-muted);
    }

    .partner-code {
      font-family: monospace;
      background: #f1f5f9;
      padding: 3px 6px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 700;
      color: #0f172a;
    }

    .action-links {
      display: flex;
      gap: 8px;
    }

    .action-btn {
      padding: 6px 10px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all 0.15s;
    }

    .action-wa {
      background: #25d366;
      color: white;
    }
    .action-wa:hover {
      background: #1eb956;
    }

    .action-call {
      background: #e2e8f0;
      color: #334155;
    }
    .action-call:hover {
      background: #cbd5e1;
    }

    .empty-state {
      text-align: center;
      padding: 48px 16px;
      color: var(--text-muted);
    }

    /* Print Styles */
    @media print {
      body {
        background: white !important;
        padding: 0 !important;
        color: black !important;
      }

      .header {
        background: white !important;
        color: black !important;
        box-shadow: none !important;
        border: 1px solid #ccc !important;
        padding: 16px !important;
        margin-bottom: 16px !important;
      }

      .header p {
        color: #555 !important;
      }

      .header-actions, .control-card, .action-links {
        display: none !important;
      }

      .stat-card {
        border: 1px solid #ddd !important;
        box-shadow: none !important;
        padding: 12px !important;
      }

      .table-container {
        box-shadow: none !important;
        border: 1px solid #ddd !important;
      }

      table {
        font-size: 11px !important;
      }

      thead th {
        background: #eee !important;
        color: black !important;
        padding: 8px !important;
      }

      tbody td {
        padding: 8px !important;
      }

      .badge-danger {
        border: 1px solid #dc2626 !important;
        color: #dc2626 !important;
        background: white !important;
      }

      .badge-success {
        border: 1px solid #16a34a !important;
        color: #16a34a !important;
        background: white !important;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <header class="header">
      <div class="header-title">
        <h1>
          <span>💼</span> DhanSource Capital - Partner Leads Audit
        </h1>
        <p>Real-time database reconciliation of Ad Leads vs. Registered App Partners • Generated on ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</p>
      </div>
      <div class="header-actions">
        <button class="btn btn-primary" onclick="window.print()">
          <span>🖨️</span> Download / Print PDF
        </button>
        <button class="btn btn-success" onclick="exportCSV()">
          <span>📥</span> Export CSV
        </button>
      </div>
    </header>

    <!-- Stats Cards -->
    <div class="stats-grid">
      <div class="stat-card blue">
        <div class="stat-info">
          <div class="stat-label">Total Leads Received</div>
          <div class="stat-value">${totalLeads}</div>
          <div class="stat-sub">${uniquePhones.size} Unique Contacts</div>
        </div>
        <div class="stat-icon">📋</div>
      </div>

      <div class="stat-card orange">
        <div class="stat-info">
          <div class="stat-label">Remaining to Register</div>
          <div class="stat-value">${remainingCount}</div>
          <div class="stat-sub">${((remainingCount / totalLeads) * 100).toFixed(1)}% pending follow-up</div>
        </div>
        <div class="stat-icon">⏳</div>
      </div>

      <div class="stat-card green">
        <div class="stat-info">
          <div class="stat-label">Successfully Registered</div>
          <div class="stat-value">${registeredCount}</div>
          <div class="stat-sub">${conversionRate} Conversion Rate</div>
        </div>
        <div class="stat-icon">✅</div>
      </div>

      <div class="stat-card purple">
        <div class="stat-info">
          <div class="stat-label">Top Location</div>
          <div class="stat-value">${topCities[0] ? topCities[0][0] : 'Maharashtra'}</div>
          <div class="stat-sub">${topCities[0] ? topCities[0][1] + ' leads' : ''}</div>
        </div>
        <div class="stat-icon">📍</div>
      </div>
    </div>

    <!-- Controls -->
    <div class="control-card">
      <div class="tabs-and-search">
        <div class="tabs">
          <button class="tab-btn active" onclick="setFilter('pending', this)">
            Remaining to Register <span class="tab-badge">${remainingCount}</span>
          </button>
          <button class="tab-btn" onclick="setFilter('registered', this)">
            Registered Partners <span class="tab-badge">${registeredCount}</span>
          </button>
          <button class="tab-btn" onclick="setFilter('all', this)">
            All Leads <span class="tab-badge">${totalLeads}</span>
          </button>
        </div>

        <div class="filter-group">
          <div class="search-box">
            <span class="search-icon">🔍</span>
            <input type="text" id="searchInput" placeholder="Search by Name, Phone, City, State..." oninput="applyFilters()" />
          </div>

          <select class="select-filter" id="stateFilter" onchange="applyFilters()">
            <option value="">All States</option>
            ${topStates.map(s => `<option value="${s[0]}">${s[0]} (${s[1]})</option>`).join("")}
          </select>

          <select class="select-filter" id="platformFilter" onchange="applyFilters()">
            <option value="">All Platforms</option>
            <option value="fb">Facebook (FB)</option>
            <option value="ig">Instagram (IG)</option>
          </select>
        </div>
      </div>
    </div>

    <!-- Table -->
    <div class="table-container">
      <table id="leadsTable">
        <thead>
          <tr>
            <th>#</th>
            <th>Lead Name</th>
            <th>Phone / WhatsApp</th>
            <th>City</th>
            <th>State</th>
            <th>Lead Date</th>
            <th>Source</th>
            <th>Status</th>
            <th>DB Details / Action</th>
          </tr>
        </thead>
        <tbody id="tableBody">
          <!-- Populated by JavaScript -->
        </tbody>
      </table>
      <div id="emptyState" class="empty-state" style="display: none;">
        <h3>No matching leads found</h3>
        <p>Try adjusting your search query or filters.</p>
      </div>
    </div>
  </div>

  <script>
    const allLeads = ${JSON.stringify(leads)};
    let currentTab = 'pending';

    function setFilter(tab, btn) {
      currentTab = tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyFilters();
    }

    function applyFilters() {
      const search = document.getElementById('searchInput').value.toLowerCase().trim();
      const state = document.getElementById('stateFilter').value;
      const platform = document.getElementById('platformFilter').value;

      const filtered = allLeads.filter(lead => {
        // Tab filter
        if (currentTab === 'pending' && lead.isRegistered) return false;
        if (currentTab === 'registered' && !lead.isRegistered) return false;

        // State filter
        if (state && lead.state !== state) return false;

        // Platform filter
        if (platform && lead.platform !== platform) return false;

        // Search text
        if (search) {
          const matchName = (lead.name || '').toLowerCase().includes(search);
          const matchPhone = (lead.phone || '').toLowerCase().includes(search);
          const matchCity = (lead.city || '').toLowerCase().includes(search);
          const matchState = (lead.state || '').toLowerCase().includes(search);
          const matchCode = (lead.dbUser?.partnerCode || '').toLowerCase().includes(search);
          const matchDbName = (lead.dbUser?.name || '').toLowerCase().includes(search);
          if (!matchName && !matchPhone && !matchCity && !matchState && !matchCode && !matchDbName) {
            return false;
          }
        }

        return true;
      });

      renderTable(filtered);
    }

    function renderTable(dataList) {
      const tbody = document.getElementById('tableBody');
      const emptyState = document.getElementById('emptyState');

      if (dataList.length === 0) {
        tbody.innerHTML = '';
        emptyState.style.display = 'block';
        return;
      }

      emptyState.style.display = 'none';

      tbody.innerHTML = dataList.map((lead, idx) => {
        const statusBadge = lead.isRegistered
          ? '<span class="badge badge-success">✓ Registered</span>'
          : '<span class="badge badge-danger">✕ Not Registered</span>';

        const platformBadge = lead.platform === 'ig'
          ? '<span class="badge-platform badge-ig">IG</span>'
          : '<span class="badge-platform badge-fb">FB</span>';

        const cleanNumber = lead.cleanPhone;
        const waMsg = encodeURIComponent('Hello ' + lead.name + ', we noticed your inquiry to join DhanSource as a Loan Partner! Complete your partner registration here: https://dhansourcecapital.com');

        const actionHtml = lead.isRegistered
          ? '<div style="font-size:12px;"><strong>' + (lead.dbUser.name || 'User') + '</strong><br><span class="partner-code">' + (lead.dbUser.partnerCode || 'Registered') + '</span></div>'
          : '<div class="action-links">' +
              '<a href="https://wa.me/91' + cleanNumber + '?text=' + waMsg + '" target="_blank" class="action-btn action-wa">💬 WhatsApp</a>' +
              '<a href="tel:+91' + cleanNumber + '" class="action-btn action-call">📞 Call</a>' +
            '</div>';

        return '<tr>' +
          '<td style="color:#94a3b8; font-weight:600;">' + (idx + 1) + '</td>' +
          '<td><div class="lead-name">' + escapeHtml(lead.name) + '</div></td>' +
          '<td><div class="lead-phone">' + escapeHtml(lead.phone) + '</div></td>' +
          '<td><span class="lead-city">' + escapeHtml(lead.city || 'N/A') + '</span></td>' +
          '<td><span class="lead-state" style="font-weight:600; color:#475569;">' + escapeHtml(lead.state || 'N/A') + '</span></td>' +
          '<td style="color:#64748b; font-size:12px;">' + lead.date + '</td>' +
          '<td>' + platformBadge + '</td>' +
          '<td>' + statusBadge + '</td>' +
          '<td>' + actionHtml + '</td>' +
        '</tr>';
      }).join('');
    }

    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function exportCSV() {
      const pendingOnly = currentTab === 'pending';
      const list = currentTab === 'pending'
        ? allLeads.filter(l => !l.isRegistered)
        : currentTab === 'registered'
          ? allLeads.filter(l => l.isRegistered)
          : allLeads;

      let csv = "ID,Name,Phone,City,State,Date,Platform,Status,PartnerCode\\n";
      list.forEach(l => {
        const row = [
          '"' + l.id + '"',
          '"' + (l.name || '').replace(/"/g, '""') + '"',
          '"' + l.phone + '"',
          '"' + (l.city || '').replace(/"/g, '""') + '"',
          '"' + (l.state || '').replace(/"/g, '""') + '"',
          '"' + l.date + '"',
          '"' + l.platform.toUpperCase() + '"',
          '"' + (l.isRegistered ? 'REGISTERED' : 'PENDING_REGISTRATION') + '"',
          '"' + (l.dbUser?.partnerCode || '') + '"'
        ];
        csv += row.join(",") + "\\n";
      });

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'DhanSource_Partner_Leads_' + currentTab + '.csv';
      a.click();
      URL.revokeObjectURL(url);
    }

    // Initial render
    applyFilters();
  </script>
</body>
</html>`;

// Write to fin_backend and project root
fs.writeFileSync(path.join(process.cwd(), "partner_leads_report.html"), htmlContent);
fs.writeFileSync(path.join(process.cwd(), "..", "partner_leads_report.html"), htmlContent);
console.log("Successfully generated partner_leads_report.html in both fin_backend and root directory!");
