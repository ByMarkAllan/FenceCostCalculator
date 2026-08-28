/**
 * RanchAssist™ / SmoothWireFence.com — Fence Cost Estimator
 * Google Apps Script backend
 *
 * RANCHASSIST RUNTIME CONFIGURATION
 * --------------------------------
 * Required Script Properties:
 *   MAPBOX_ACCESS_TOKEN = pk.your_public_mapbox_token
 *
 * Optional public runtime configuration:
 *   DEFAULT_MAP_STYLE = mapbox://styles/mapbox/standard-satellite
 *   SUPPORT_EMAIL = support@ranchassist.com
 *   FEATURE_EMAIL_SHARE = true
 *
 * Optional server-only email configuration:
 *   QUOTE_FROM_NAME = RanchAssist
 *   QUOTE_REPLY_TO = support@ranchassist.com
 *
 * Security rule: never return all Script Properties to the browser.

 * SIMPLIFIED SOURCE STRUCTURE
 * ---------------------------
 *   Code.gs            Secure Apps Script backend/runtime configuration
 *   Index.html         Complete editable frontend (HTML + CSS + JavaScript)
 *   appsscript.json    Apps Script manifest
 *   README_SETUP.txt   Setup, deployment, security and QA instructions
 *
 * Index.html is the canonical frontend. No HTML partial files are required.
 */

const SWF = Object.freeze({
  APP_NAME: 'SmoothWireFence.com',
  TOOL_NAME: 'Fence Cost Estimator',
  BRAND_NAME: 'RanchAssist',
  DEFAULT_FROM_NAME: 'RanchAssist',
  DEFAULT_MAP_STYLE: 'mapbox://styles/mapbox/standard-satellite',
  MAX_RECIPIENTS: 5,
  MAX_NOTES_LENGTH: 3000,
  MAX_BOM_ROWS: 100,
  MAX_SENDS_PER_HOUR: 30
});

function doGet() {
  const template = HtmlService.createTemplateFromFile('Index');
  template.runtimeConfigJson = safeJsonForHtml_(getPublicRuntimeConfig());

  return template.evaluate()
    .setTitle('RanchAssist | Fence Cost Estimator')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}


/**
 * Explicit client-safe allowlist.
 * This function must never return getProperties() or any server-only secret.
 */
function getPublicRuntimeConfig() {
  const props = PropertiesService.getScriptProperties();
  const mapboxAccessToken = props.getProperty('MAPBOX_ACCESS_TOKEN') || '';
  const defaultMapStyle = cleanPublicConfigText_(
    props.getProperty('DEFAULT_MAP_STYLE') || SWF.DEFAULT_MAP_STYLE,
    300
  );
  const supportEmail = cleanPublicConfigText_(props.getProperty('SUPPORT_EMAIL') || '', 180);
  const emailShareEnabled = parseBooleanProperty_(
    props.getProperty('FEATURE_EMAIL_SHARE'),
    true
  );

  return {
    appName: SWF.APP_NAME,
    brandName: SWF.BRAND_NAME,
    toolName: SWF.TOOL_NAME,
    mapboxAccessToken: isPublicMapboxToken_(mapboxAccessToken) ? mapboxAccessToken : '',
    defaultMapStyle: defaultMapStyle,
    supportEmail: isEmail_(supportEmail) ? supportEmail : '',
    featureFlags: {
      emailShare: emailShareEnabled
    },
    services: {
      map: {
        configured: isPublicMapboxToken_(mapboxAccessToken)
      },
      emailShare: {
        configured: emailShareEnabled
      }
    }
  };
}

/**
 * Optional non-secret diagnostics. This returns status only, never values.
 */
function getRuntimeDiagnostics() {
  const props = PropertiesService.getScriptProperties();
  return {
    mapService: isPublicMapboxToken_(props.getProperty('MAPBOX_ACCESS_TOKEN') || '') ? 'Configured' : 'Missing',
    emailSharing: parseBooleanProperty_(props.getProperty('FEATURE_EMAIL_SHARE'), true) ? 'Available' : 'Disabled',
    environment: cleanPublicConfigText_(props.getProperty('APP_ENV') || 'production', 40)
  };
}

/**
 * Sends a formatted fence estimate email using Apps Script MailApp.
 * No API credential is exposed to the browser.
 * @param {Object} payload Data created by the front-end share dialog.
 * @return {{ok:boolean,message:string}}
 */
function sendEstimate(payload) {
  try {
    const props = PropertiesService.getScriptProperties();
    if (!parseBooleanProperty_(props.getProperty('FEATURE_EMAIL_SHARE'), true)) {
      throw new Error('Email sharing is unavailable in this deployment.');
    }

    payload = payload || {};
    const recipients = normalizeRecipients_(payload.to);
    if (!recipients.length) throw new Error('Enter at least one valid email address.');
    if (recipients.length > SWF.MAX_RECIPIENTS) {
      throw new Error('You can send to up to ' + SWF.MAX_RECIPIENTS + ' recipients at once.');
    }

    enforceMailRateLimit_();
    if (MailApp.getRemainingDailyQuota() < recipients.length) {
      throw new Error('Email sharing is temporarily unavailable because the daily send quota has been reached.');
    }

    const project = sanitizeProject_(payload.project || {});
    const bom = sanitizeBom_(payload.bom || []);
    const message = cleanText_(payload.message || '', SWF.MAX_NOTES_LENGTH);
    const senderName = cleanText_(props.getProperty('QUOTE_FROM_NAME') || SWF.DEFAULT_FROM_NAME, 120);
    const replyTo = props.getProperty('QUOTE_REPLY_TO') || '';

    const subject = cleanText_(
      payload.subject ||
      (project.name ? project.name + ' — Fence Estimate' : 'Fence Estimate — ' + SWF.APP_NAME),
      180
    );

    const htmlBody = buildEstimateEmail_(project, bom, message);
    const plainBody = buildPlainTextEmail_(project, bom, message);

    const mail = {
      to: recipients.join(','),
      subject: subject,
      body: plainBody,
      htmlBody: htmlBody,
      name: senderName
    };
    if (isEmail_(replyTo)) mail.replyTo = replyTo;

    MailApp.sendEmail(mail);
    return { ok: true, message: 'Estimate sent successfully.' };
  } catch (err) {
    // Never log payloads, credentials, or authorization headers.
    console.error('Estimate email failed: ' + cleanLogMessage_(err && err.message ? err.message : 'Unknown error'));
    return {
      ok: false,
      message: err && err.message ? cleanText_(err.message, 260) : 'Unable to send estimate.'
    };
  }
}

function enforceMailRateLimit_() {
  const cache = CacheService.getScriptCache();
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const key = 'ra_fence_mail_hour_' +
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMddHH');
    const current = Number(cache.get(key) || 0);
    if (current >= SWF.MAX_SENDS_PER_HOUR) {
      throw new Error('Email sharing is temporarily rate-limited. Please try again later.');
    }
    cache.put(key, String(current + 1), 3600);
  } finally {
    lock.releaseLock();
  }
}

function sanitizeProject_(project) {
  const p = project || {};
  return {
    projectId: cleanText_(p.projectId || '', 80),
    name: cleanText_(p.name || 'Fence Project', 160),
    address: cleanText_(p.address || '', 250),
    lengthFeet: toNumber_(p.lengthFeet),
    netFenceFeet: toNumber_(p.netFenceFeet),
    cornerCount: toInt_(p.cornerCount),
    gateCount: toInt_(p.gateCount),
    gateOpeningFeet: toNumber_(p.gateOpeningFeet),
    wireType: cleanText_(p.wireType || '', 80),
    wireLines: toInt_(p.wireLines),
    postType: cleanText_(p.postType || '', 80),
    postSpacing: toNumber_(p.postSpacing),
    electricFence: Boolean(p.electricFence),
    energizerType: cleanText_(p.energizerType || '', 80),
    estimatedTotal: toNumber_(p.estimatedTotal),
    materialSubtotal: toNumber_(p.materialSubtotal),
    tax: toNumber_(p.tax),
    labor: toNumber_(p.labor),
    contingency: toNumber_(p.contingency),
    coordinates: sanitizeCoordinates_(p.coordinates || []),
    unitSystem: p.unitSystem === 'meters' ? 'meters' : 'feet',
    notes: cleanText_(p.notes || '', SWF.MAX_NOTES_LENGTH),
    generatedAt: cleanText_(p.generatedAt || new Date().toISOString(), 60)
  };
}

function sanitizeCoordinates_(coords) {
  if (!Array.isArray(coords)) return [];
  return coords.slice(0, 500).map(function(pair) {
    if (!Array.isArray(pair) || pair.length < 2) return null;
    const lng = Number(pair[0]);
    const lat = Number(pair[1]);
    if (!isFinite(lng) || !isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;
    return [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
  }).filter(Boolean);
}

function sanitizeBom_(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, SWF.MAX_BOM_ROWS).map(function(row) {
    return {
      category: cleanText_(row.category || '', 80),
      item: cleanText_(row.item || '', 160),
      qty: toNumber_(row.qty),
      unit: cleanText_(row.unit || '', 30),
      unitCost: toNumber_(row.unitCost),
      total: toNumber_(row.total)
    };
  });
}

function buildEstimateEmail_(project, bom, message) {
  const routeBlock = project.coordinates.length
    ? '<div style="margin-top:16px;padding:14px 16px;border:1px solid #DEDED8;border-radius:8px;background:#F7F7F4">' +
      '<div style="font-size:11px;font-weight:700;letter-spacing:.10em;text-transform:uppercase;color:#666660;margin-bottom:7px">Mapped fence path</div>' +
      '<div style="font-size:13px;color:#4D4D48;line-height:1.6">' +
      escapeHtml_(project.coordinates.length + ' mapped nodes') +
      ' · Start: ' + escapeHtml_(formatCoord_(project.coordinates[0])) +
      (project.coordinates.length > 1
        ? ' · End: ' + escapeHtml_(formatCoord_(project.coordinates[project.coordinates.length - 1]))
        : '') +
      '</div></div>'
    : '';

  const bomRows = bom.map(function(row) {
    return '<tr>' +
      '<td style="padding:11px 10px;border-bottom:1px solid #DEDED8;color:#666660;font-size:11px;text-transform:uppercase;letter-spacing:.05em">' + escapeHtml_(row.category) + '</td>' +
      '<td style="padding:11px 10px;border-bottom:1px solid #DEDED8;color:#171715;font-size:14px;font-weight:600">' + escapeHtml_(row.item) + '</td>' +
      '<td style="padding:11px 10px;border-bottom:1px solid #DEDED8;color:#4D4D48;font-size:14px;text-align:right;white-space:nowrap">' + escapeHtml_(formatQty_(row.qty) + ' ' + row.unit) + '</td>' +
      '<td style="padding:11px 10px;border-bottom:1px solid #DEDED8;color:#4D4D48;font-size:14px;text-align:right;white-space:nowrap">' + money_(row.unitCost) + '</td>' +
      '<td style="padding:11px 10px;border-bottom:1px solid #DEDED8;color:#171715;font-size:14px;font-weight:700;text-align:right;white-space:nowrap">' + money_(row.total) + '</td>' +
      '</tr>';
  }).join('');

  const notes = [message, project.notes].filter(Boolean).join('\n\n');
  const notesBlock = notes
    ? '<div style="margin-top:22px;padding:18px;border:1px solid #DEDED8;border-radius:8px;background:#FFFFFF">' +
      '<div style="font-size:11px;font-weight:700;letter-spacing:.10em;text-transform:uppercase;color:#666660;margin-bottom:8px">Project notes</div>' +
      '<div style="font-size:14px;line-height:1.7;color:#353532;white-space:pre-wrap">' + escapeHtml_(notes) + '</div></div>'
    : '';

  return '<!doctype html><html><body style="margin:0;background:#F7F7F4;font-family:Arial,sans-serif;color:#171715">' +
    '<div style="max-width:780px;margin:0 auto;padding:28px 14px">' +
      '<div style="background:#0A0A09;border-radius:10px 10px 0 0;padding:24px 26px;color:#FFFFFF">' +
        '<div style="font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#C5C5BD">RanchAssist™ / Fence Cost Estimator</div>' +
        '<div style="font-size:28px;font-weight:700;line-height:1.2;margin-top:8px">' + escapeHtml_(project.name) + '</div>' +
        (project.address ? '<div style="font-size:14px;color:#DEDED8;margin-top:6px">' + escapeHtml_(project.address) + '</div>' : '') +
      '</div>' +
      '<div style="background:#FFFFFF;padding:26px;border:1px solid #DEDED8;border-top:0;border-radius:0 0 10px 10px">' +
        '<div style="display:table;width:100%;table-layout:fixed">' +
          metricCard_('Mapped length', formatFeet_(project.lengthFeet)) +
          metricCard_('Net fence', formatFeet_(project.netFenceFeet)) +
          metricCard_('Corners / nodes', String(project.cornerCount)) +
          metricCard_('Estimate', money_(project.estimatedTotal)) +
        '</div>' +
        routeBlock +
        '<div style="margin-top:24px;font-size:18px;font-weight:700">Bill of materials</div>' +
        '<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-top:10px;border:1px solid #DEDED8">' +
          '<thead><tr style="background:#F1F1ED">' +
            '<th style="padding:10px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#666660">Category</th>' +
            '<th style="padding:10px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#666660">Item</th>' +
            '<th style="padding:10px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#666660">Qty</th>' +
            '<th style="padding:10px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#666660">Unit</th>' +
            '<th style="padding:10px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#666660">Total</th>' +
          '</tr></thead><tbody>' + bomRows + '</tbody>' +
        '</table>' +
        '<div style="margin-top:18px;border-top:2px solid #0A0A09;padding-top:14px">' +
          totalRow_('Materials', project.materialSubtotal) +
          totalRow_('Labor', project.labor) +
          totalRow_('Contingency / overhead', project.contingency) +
          totalRow_('Tax', project.tax) +
          '<div style="display:flex;justify-content:space-between;gap:20px;margin-top:9px;font-size:20px;font-weight:700"><span>Estimated total</span><span>' + money_(project.estimatedTotal) + '</span></div>' +
        '</div>' +
        notesBlock +
        '<div style="margin-top:22px;padding-top:16px;border-top:1px solid #DEDED8;font-size:12px;line-height:1.6;color:#666660">' +
          'Estimate generated by RanchAssist™ / SmoothWireFence.com. Material quantities and pricing are planning estimates. Verify field conditions, utility locations, applicable requirements, supplier pricing, and final installation requirements before purchase or construction.' +
        '</div>' +
      '</div>' +
    '</div></body></html>';
}

function buildPlainTextEmail_(project, bom, message) {
  const lines = [
    'RANCHASSIST™ / FENCE COST ESTIMATOR',
    'SmoothWireFence.com',
    project.name,
    project.address || '',
    '',
    'Mapped length: ' + formatFeet_(project.lengthFeet),
    'Net fence: ' + formatFeet_(project.netFenceFeet),
    'Corners / nodes: ' + project.cornerCount,
    'Gates: ' + project.gateCount + ' (' + formatFeet_(project.gateOpeningFeet) + ' openings)',
    '',
    'BILL OF MATERIALS'
  ];

  bom.forEach(function(row) {
    lines.push('- ' + row.item + ': ' + formatQty_(row.qty) + ' ' + row.unit + ' × ' + money_(row.unitCost) + ' = ' + money_(row.total));
  });

  lines.push('', 'Materials: ' + money_(project.materialSubtotal));
  lines.push('Labor: ' + money_(project.labor));
  lines.push('Contingency / overhead: ' + money_(project.contingency));
  lines.push('Tax: ' + money_(project.tax));
  lines.push('ESTIMATED TOTAL: ' + money_(project.estimatedTotal));

  if (message || project.notes) lines.push('', 'NOTES', [message, project.notes].filter(Boolean).join('\n\n'));
  lines.push('', 'Planning estimate only. Verify field conditions, utility locations, applicable requirements, supplier pricing, and installation requirements.');
  return lines.filter(function(v, i, arr) {
    return !(v === '' && arr[i - 1] === '');
  }).join('\n');
}

function metricCard_(label, value) {
  return '<div style="display:table-cell;width:25%;padding:0 8px 0 0;vertical-align:top">' +
    '<div style="border:1px solid #DEDED8;border-radius:8px;padding:12px">' +
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#666660">' + escapeHtml_(label) + '</div>' +
      '<div style="font-size:17px;font-weight:700;margin-top:4px;color:#171715">' + escapeHtml_(value) + '</div>' +
    '</div></div>';
}

function totalRow_(label, value) {
  return '<div style="display:flex;justify-content:space-between;gap:20px;font-size:14px;line-height:1.9;color:#4D4D48"><span>' +
    escapeHtml_(label) + '</span><span>' + money_(value) + '</span></div>';
}

function normalizeRecipients_(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[;,\s]+/);
  const unique = {};
  raw.forEach(function(item) {
    const email = String(item || '').trim().toLowerCase();
    if (isEmail_(email)) unique[email] = true;
  });
  return Object.keys(unique);
}

function isEmail_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(String(email || ''));
}

function cleanText_(value, maxLen) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, maxLen || 500);
}

function cleanPublicConfigText_(value, maxLen) {
  return cleanText_(value, maxLen).replace(/[<>"']/g, '');
}

function cleanLogMessage_(value) {
  return String(value || '')
    .replace(/(pk\.[A-Za-z0-9._-]+)/g, '[REDACTED_PUBLIC_TOKEN]')
    .replace(/(sk_[A-Za-z0-9._-]+)/g, '[REDACTED]')
    .slice(0, 400);
}

function escapeHtml_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function toNumber_(value) {
  const n = Number(value);
  return isFinite(n) ? Math.max(0, Math.round(n * 100) / 100) : 0;
}

function toInt_(value) {
  const n = parseInt(value, 10);
  return isFinite(n) ? Math.max(0, n) : 0;
}

function money_(value) {
  return '$' + toNumber_(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatFeet_(value) {
  return toNumber_(value).toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' ft';
}

function formatQty_(value) {
  const n = toNumber_(value);
  return n.toLocaleString('en-US', { maximumFractionDigits: n % 1 ? 2 : 0 });
}

function formatCoord_(pair) {
  if (!pair || pair.length < 2) return '';
  return Number(pair[1]).toFixed(5) + ', ' + Number(pair[0]).toFixed(5);
}

function isPublicMapboxToken_(value) {
  return /^pk\.[A-Za-z0-9._-]{20,}$/.test(String(value || '').trim());
}

function parseBooleanProperty_(value, defaultValue) {
  if (value == null || value === '') return Boolean(defaultValue);
  return !/^(false|0|no|off)$/i.test(String(value).trim());
}

function safeJsonForHtml_(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
