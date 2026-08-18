const fs = require('fs');
const path = 'd:/RescueClick Pvt Ltd/DhanSource APP/trustline_final_app/fin_backend/src/routes/rm.routes.js';
let content = fs.readFileSync(path, 'utf8');

const regex1 = /\$or:\s*\[\s*\{\s*rmId\s*:\s*(rmId|rmIdPost)\s*\},[^\{]*\{\s*partnerId\s*:\s*\{\s*\$in\s*:\s*(partnerIds|partnerIdsPost)\s*\}\s*\}[^\]]*\]/g;

content = content.replace(regex1, (match, idStr, pIdsStr) => {
  return `$or: [
    { partnerId: { $in: ${pIdsStr} } },
    { partnerId: null, rmId: ${idStr} },
    { partnerId: { $exists: false }, rmId: ${idStr} }
  ]`;
});

fs.writeFileSync(path, content, 'utf8');
console.log('Done fixing remaining scopes');
