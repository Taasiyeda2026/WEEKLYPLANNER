const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PORT = Number(process.env.PORT || 8080);
const HOST = '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILES = {
  instructor: path.join(DATA_DIR, 'InstructorData.xlsx'),
  programRules: path.join(DATA_DIR, 'ProgramRules.xlsx'),
  globalMessages: path.join(DATA_DIR, 'GlobalMessages.xlsx')
};
const ALLOW_LEGACY_SHA = process.env.ALLOW_LEGACY_SHA === 'true';
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;

const sessions = new Map();
let dataStore = { instructors: [], programRules: {}, globalMessages: [] };

function cleanValue(value){
  if(value === undefined || value === null) return '';
  return String(value).trim();
}
function normalizeProgramName(name){
  return cleanValue(name).toLocaleLowerCase('en-US');
}
function parseJsonBody(req){
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if(data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if(!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}
function sendJson(res, status, payload){
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function sendText(res, status, text){
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}
function mimeType(filePath){
  if(filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if(filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if(filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if(filePath.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}
function serveFile(res, filePath){
  if(!fs.existsSync(filePath)) return sendText(res, 404, 'Not found');
  const stream = fs.createReadStream(filePath);
  res.writeHead(200, { 'Content-Type': mimeType(filePath) });
  stream.pipe(res);
}
function parseXlsx(filePath, mode = 'objects'){
  const result = spawnSync('python3', [path.join(__dirname, 'scripts/parse_xlsx.py'), filePath, mode], { encoding: 'utf8' });
  if(result.status !== 0){
    throw new Error(result.stderr || 'Failed to parse xlsx');
  }
  return JSON.parse(result.stdout);
}
async function ensureDataFiles(){
  await fsp.mkdir(DATA_DIR, { recursive: true });
  for(const file of Object.values(DATA_FILES)){
    await fsp.access(file);
  }
}
async function loadData(){
  const instructors = parseXlsx(DATA_FILES.instructor, 'objects').map(row => {
    const employeeId = cleanValue(row.EmployeeID);
    const salt = cleanValue(row.Salt) || (employeeId ? `emp-${employeeId}` : 'default-salt');
    const passwordHash = cleanValue(row.PasswordHash || row.ScryptHash);
    const normalized = { ...row, Salt: salt };

    if(passwordHash){
      normalized.PasswordHash = passwordHash;
      return normalized;
    }

    const codeValue = cleanValue(row.Code);
    if(codeValue){
      normalized.PasswordHash = crypto.scryptSync(codeValue, salt, 64).toString('hex');
      delete normalized.Code;
    }

    return normalized;
  });
  const programRows = parseXlsx(DATA_FILES.programRules, 'arrays');
  const globalRows = parseXlsx(DATA_FILES.globalMessages, 'objects');

  const programRules = {};
  for(let i = 1; i < programRows.length; i++){
    const row = programRows[i] || [];
    const programKey = normalizeProgramName(row[0]);
    const meetingNum = Number(row[1]);
    if(!programKey || !Number.isFinite(meetingNum)) continue;
    if(!programRules[programKey]) programRules[programKey] = {};
    const notes = [];
    for(let j = 2; j + 1 < row.length; j += 2){
      const type = cleanValue(row[j]);
      const text = cleanValue(row[j + 1]);
      if(type && text) notes.push({ type, text });
    }
    programRules[programKey][meetingNum] = notes;
  }

  const globalMessages = globalRows.filter(r => cleanValue(r.Message)).map(r => ({
    message: cleanValue(r.Message),
    type: cleanValue(r.Type) || 'Info'
  }));

  dataStore = { instructors, programRules, globalMessages };
}
function hashWithSaltSHA256(code, salt){
  return crypto.createHash('sha256').update(`${salt}${code}`).digest('hex');
}
function verifyPassword(row, code){
  const scryptHash = cleanValue(row.PasswordHash || row.ScryptHash);
  const salt = cleanValue(row.Salt);
  if(scryptHash && salt){
    const derived = crypto.scryptSync(code, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(scryptHash, 'hex'));
  }
  if(salt && cleanValue(row.Code)){
    return hashWithSaltSHA256(code, salt) === cleanValue(row.Code);
  }
  if(ALLOW_LEGACY_SHA && cleanValue(row.Code)){
    const legacy = crypto.createHash('sha256').update(code).digest('hex');
    return legacy === cleanValue(row.Code);
  }
  return false;
}
function createSession(employeeId, employeeName){
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { employeeId, employeeName, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}
function getSession(req){
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const session = sessions.get(token);
  if(!session) return null;
  if(session.expiresAt < Date.now()){ sessions.delete(token); return null; }
  return { token, ...session };
}
function hasValue(value){
  return value !== undefined && value !== null && cleanValue(value) !== '';
}
function extractActivities(row){
  const activities = [];
  for(let i = 1; i <= 16; i++){
    const dateField = row[`Date${i}`] || (i === 1 ? row.Date : undefined);
    if(!hasValue(dateField)) continue;
    const cancelField = row[`Cancel${i}`] || (i === 1 ? row.Cancel : undefined);
    if(hasValue(cancelField)) continue;

    const program = cleanValue(row[`Program${i}`] || (i === 1 ? row.Program : ''));
    activities.push({
      date: new Date(dateField).toISOString(),
      program,
      programKey: normalizeProgramName(program),
      startTime: row[`StartTime${i}`] || (i === 1 ? row.StartTime : ''),
      endTime: row[`EndTime${i}`] || (i === 1 ? row.EndTime : ''),
      manager: cleanValue(row[`Manager${i}`] || (i === 1 ? row.Manager : '')),
      school: cleanValue(row[`School${i}`] || (i === 1 ? row.School : '')),
      className: cleanValue(row[`Class${i}`] || (i === 1 ? row.Class : '')),
      authority: cleanValue(row[`Authority${i}`] || (i === 1 ? row.Authority : '')),
      meetingNumber: i
    });
  }
  return activities;
}

const routes = {
  '/': () => ['file', 'index.html'],
  '/sw.js': () => ['file', 'sw.js'],
  '/manifest.json': () => ['file', 'manifest.json'],
  '/hash-generator.html': () => ['file', 'hash-generator.html'],
  '/logo.png': () => ['file', 'logo.png'],
  '/icon-192.png': () => ['file', 'icon-192.png'],
  '/icon-512.png': () => ['file', 'icon-512.png']
};

const server = http.createServer(async (req, res) => {
  try {
    if(['/InstructorData.xlsx', '/ProgramRules.xlsx', '/GlobalMessages.xlsx'].includes(req.url)){
      return sendText(res, 403, 'Direct access to Excel files is forbidden.');
    }

    if(req.method === 'POST' && req.url === '/api/login'){
      const body = await parseJsonBody(req);
      const employeeId = cleanValue(body.employeeId);
      const code = cleanValue(body.code);
      if(!employeeId || !code) return sendJson(res, 400, { error: 'Missing credentials' });

      const row = dataStore.instructors.find(item => cleanValue(item.EmployeeID) === employeeId);
      if(!row || !verifyPassword(row, code)) return sendJson(res, 401, { error: 'Invalid credentials' });

      const token = createSession(employeeId, cleanValue(row.Employee));
      return sendJson(res, 200, { token, employeeName: cleanValue(row.Employee) });
    }

    if(req.method === 'GET' && req.url === '/api/me/schedule'){
      const session = getSession(req);
      if(!session) return sendJson(res, 401, { error: 'Unauthorized' });

      const row = dataStore.instructors.find(item => cleanValue(item.EmployeeID) === session.employeeId);
      if(!row) return sendJson(res, 404, { error: 'Employee not found' });

      return sendJson(res, 200, {
        employeeName: cleanValue(row.Employee),
        activities: extractActivities(row),
        programRules: dataStore.programRules,
        globalMessages: dataStore.globalMessages
      });
    }

    if(req.method === 'POST' && req.url === '/api/logout'){
      const session = getSession(req);
      if(!session) return sendJson(res, 401, { error: 'Unauthorized' });
      sessions.delete(session.token);
      res.writeHead(204);
      return res.end();
    }

    const route = routes[req.url];
    if(route){
      const [, file] = route();
      return serveFile(res, path.join(__dirname, file));
    }

    return sendText(res, 404, 'Not found');
  } catch (error){
    return sendJson(res, 500, { error: 'Server error', detail: error.message });
  }
});

(async function bootstrap(){
  await ensureDataFiles();
  await loadData();
  setInterval(() => loadData().catch(() => {}), 5 * 60 * 1000);
  server.listen(PORT, HOST, () => {
    console.log(`Server listening on http://${HOST}:${PORT}`);
  });
})();
