// iCloud (CloudKit JS), kept apart from everything else. Off until an API token is set below.
// Hunter: create the container iCloud.com.hunterdavis.juice in the Apple Developer portal, add record types
// Drive and PlannedDrive (each with a String field "json" holding the full record JSON), make a web API token
// for the production environment, and paste it into apiToken.

export const CONFIG = {
  containerIdentifier: "iCloud.com.hunterdavis.juice",
  apiToken: "",
  environment: "production",
};

export const enabled = () => !!CONFIG.apiToken;

let loading = null;
function loadScript() {
  if (globalThis.CloudKit) return Promise.resolve(globalThis.CloudKit);
  loading ??= new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.apple-cloudkit.com/ck/2/cloudkit.js";
    s.async = true;
    s.onload = () => res(globalThis.CloudKit);
    s.onerror = () => rej(new Error("cloudkit.js"));
    document.head.appendChild(s);
  });
  return loading;
}

function fromRecord(r) {
  const f = r.fields || {};
  if (f.json?.value) { try { return JSON.parse(f.json.value); } catch { /* fall through */ } }
  const o = { id: r.recordName };
  for (const [k, v] of Object.entries(f)) o[k] = v.value;
  return o;
}

async function queryAll(db, recordType) {
  const out = [];
  let resp = await db.performQuery({ recordType });
  for (;;) {
    if (resp.hasErrors) throw resp.errors[0];
    out.push(...resp.records.map(fromRecord));
    if (!resp.moreComing) break;
    resp = await db.performQuery(resp);
  }
  return out;
}

/**
 * Puts Apple's sign-in button in `host` and, once signed in, calls onData with an object in the juice-export
 * shape ({ format, drives, planned }) so the normal import merge can take it.
 */
export async function mount(host, { onData, onError }) {
  if (!enabled()) return;
  host.innerHTML = `<div id="apple-sign-in-button"></div><div id="apple-sign-out-button"></div>`;
  try {
    const CK = await loadScript();
    CK.configure({
      containers: [{
        containerIdentifier: CONFIG.containerIdentifier,
        apiTokenAuth: { apiToken: CONFIG.apiToken, persist: true,
          signInButton: { id: "apple-sign-in-button", theme: "white-with-outline" },
          signOutButton: { id: "apple-sign-out-button", theme: "black" } },
        environment: CONFIG.environment,
      }],
    });
    const container = CK.getDefaultContainer();
    const pull = async () => {
      const db = container.privateCloudDatabase;
      const [drives, planned] = await Promise.all([queryAll(db, "Drive"), queryAll(db, "PlannedDrive")]);
      onData({ format: "juice-export", version: 1, drives, planned });
    };
    const wait = () => container.whenUserSignsIn().then(() => pull().then(() => container.whenUserSignsOut().then(wait))).catch(onError);
    const user = await container.setUpAuth();
    if (user) await pull();
    if (user) container.whenUserSignsOut().then(wait); else wait();
  } catch (e) { onError?.(e); }
}
