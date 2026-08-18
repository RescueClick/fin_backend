const fs = require('fs');

const path = 'd:/RescueClick Pvt Ltd/DhanSource APP/trustline_final_app/fin_backend/src/routes/rm.routes.js';
let content = fs.readFileSync(path, 'utf8');

const regex1 = /\$or:\s*\[\s*\{\s*rmId\s*:\s*(rmId|new mongoose\.Types\.ObjectId\(rmId\))\s*(?:,\s*status\s*:\s*"([^"]+)")?\s*\},\s*\{\s*partnerId\s*:\s*\{\s*\$in\s*:\s*partnerIds\s*\}\s*(?:,\s*status\s*:\s*"\2")?\s*\}\s*\]/g;
const regex2 = /\$or:\s*\[\s*\{\s*partnerId\s*:\s*\{\s*\$in\s*:\s*partnerIds\s*\}\s*(?:,\s*status\s*:\s*"([^"]+)")?\s*\},\s*\{\s*rmId\s*:\s*(rmId|new mongoose\.Types\.ObjectId\(rmId\))\s*(?:,\s*status\s*:\s*"\1")?\s*\}\s*\]/g;
const regex3 = /\{\s*partnerId\s*:\s*\{\s*\$in\s*:\s*partnerIds\s*\}\s*\}/g;

const replacement = (match, p1, p2) => {
  let statusStr = p2 ? `, status: "${p2}"` : '';
  let idStr = p1 || p2 || 'rmId';
  if (idStr === 'DISBURSED' || idStr === 'UNDER_REVIEW') idStr = 'rmId';
  if (match.includes('mongoose.Types.ObjectId')) idStr = 'new mongoose.Types.ObjectId(rmId)';
  
  return `$or: [
    { partnerId: { $in: partnerIds }${statusStr} },
    { partnerId: null, rmId: ${idStr}${statusStr} },
    { partnerId: { $exists: false }, rmId: ${idStr}${statusStr} }
  ]`;
};

content = content.replace(regex1, replacement);
content = content.replace(regex2, replacement);

fs.writeFileSync(path, content, 'utf8');
console.log('Done');
