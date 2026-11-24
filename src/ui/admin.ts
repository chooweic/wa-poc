// The admin pages (/admin): plain server-rendered HTML forms, no framework.
//   KB            - for business users: free text, dropdowns and toggles only
//   Technical     - for the admin/developer: the JSON Schemas
//   Drafts, Conversations - read-only views
//   Demo          - reset buttons

import { isSameOrigin } from '../auth';
import { getConversation, listConversations, listMessages } from '../conversations-repo';
import { getDraft, listDraftEvidence, listDrafts, type Draft } from '../drafts-repo';
import type { Env } from '../env';
import {
  deleteRow,
  getArticle,
  getReason,
  getType,
  listArticles,
  listTypesWithReasons,
  moveRow,
  saveArticle,
  saveReason,
  saveReasonSchema,
  saveType,
  saveTypeSchema,
  setActive,
  type EvidenceRule,
  type KbTable,
} from '../kb-repo';
import { clearConversations, seedMockData } from '../mock-app/seed';
import { deleteMockUser, listMockUsers, parseUserInput, saveMockUser, type UserInput } from '../mock-app/users';
import { html, htmlResponse, raw, redirect, type Raw } from '../util';
import { checkSchemaText } from '../validation';

const CSS = `
:root{--page:#f4f6f8;--panel:#fff;--ink:#17202b;--muted:#68737f;--line:#dde3ea;--accent:#1f6feb;--accent-ink:#fff;
--ok:#17794a;--ok-bg:#dff5e8;--warn:#8a5a00;--warn-bg:#fdefc8;--bad:#b42318;--bad-bg:#fde4e1;--code:#f1f4f7;--me:#d6ebff}
@media (prefers-color-scheme:dark){:root{--page:#0d1117;--panel:#161b22;--ink:#e6edf3;--muted:#8b949e;--line:#2a313a;--accent:#4c9aff;--accent-ink:#0b1220;
--ok:#56d364;--ok-bg:#12301f;--warn:#e3b341;--warn-bg:#3a2d08;--bad:#ff7b72;--bad-bg:#3d1513;--code:#0f141a;--me:#173a63}}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}
header{background:var(--panel);border-bottom:1px solid var(--line);padding:10px 16px 0}
header .top{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:baseline}
header h1{font-size:17px;margin:0}
header .links{margin-left:auto;display:flex;gap:14px;font-size:13px}
nav{display:flex;gap:2px;overflow-x:auto;margin-top:8px}
nav a{padding:8px 12px;color:var(--muted);border-bottom:2px solid transparent;white-space:nowrap}
nav a.on{color:var(--ink);border-color:var(--accent);font-weight:600}
main{max-width:980px;margin:0 auto;padding:16px}
h2{font-size:16px;margin:22px 0 8px}
h2:first-child{margin-top:0}
h3{font-size:15px;margin:0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.row .grow{flex:1 1 200px;min-width:0}
.sub{color:var(--muted);font-size:13px}
.guide{white-space:pre-wrap;color:var(--muted);font-size:13px;margin:6px 0 0;max-height:4.6em;overflow:hidden}
.reason{border-top:1px solid var(--line);padding:10px 0 0;margin-top:10px}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;background:var(--code);color:var(--muted)}
.pill.ok{color:var(--ok);background:var(--ok-bg)}.pill.warn{color:var(--warn);background:var(--warn-bg)}.pill.bad{color:var(--bad);background:var(--bad-bg)}
.actions{display:flex;flex-wrap:wrap;gap:6px}
.actions form{margin:0}
button,.btn{font:inherit;font-size:13px;padding:5px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer;display:inline-block}
button:hover,.btn:hover{border-color:var(--accent)}
button.primary,.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600;padding:8px 16px;font-size:14px}
button.danger{color:var(--bad)}
label{display:block;font-weight:600;margin:14px 0 4px}
label.check{font-weight:400;display:flex;gap:8px;align-items:center}
input[type=text],input[type=number],select,textarea{width:100%;font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
textarea{min-height:120px;resize:vertical}
textarea.tall{min-height:260px}
textarea.code{font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;min-height:200px}
.hint{color:var(--muted);font-size:13px;margin:4px 0 0}
.help{background:var(--code);border-radius:10px;padding:10px 14px;font-size:13px;margin:8px 0 14px}
.help ul{margin:6px 0 0;padding-left:18px}
.msg{padding:10px 14px;border-radius:10px;margin-bottom:14px;background:var(--ok-bg);color:var(--ok)}
.msg.err{background:var(--bad-bg);color:var(--bad)}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);padding:1px 5px;border-radius:5px}
.chat{display:flex;flex-direction:column;gap:6px}
.bubble{max-width:85%;padding:7px 10px;border-radius:12px;border:1px solid var(--line);background:var(--panel);white-space:pre-wrap;overflow-wrap:anywhere}
.bubble.in{align-self:flex-end;background:var(--me);border-color:transparent}
.bubble small{display:block;color:var(--muted);font-size:11px;margin-top:2px}
`;

type Tab = 'kb' | 'technical' | 'drafts' | 'conversations' | 'users' | 'demo';

function layout(tab: Tab, title: string, body: Raw, flash?: { text: string; error?: boolean }): Response {
  const tabs: [Tab, string, string][] = [
    ['kb', 'Knowledge base', '/admin/kb'],
    ['technical', 'Technical', '/admin/technical'],
    ['drafts', 'Drafts', '/admin/drafts'],
    ['conversations', 'Conversations', '/admin/conversations'],
    ['users', 'Test users', '/admin/users'],
    ['demo', 'Demo', '/admin/demo'],
  ];
  const page = html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Attendance Business Agent</title><style>${raw(CSS)}</style></head>
<body>
<header>
  <div class="top"><h1>Attendance Business Agent <span class="sub">Admin</span></h1>
    <div class="links"><a href="/mock-wa" target="mockwa">Mock WhatsApp ↗</a><a href="/mock-app" target="mockapp">Mock target app ↗</a></div>
  </div>
  <nav>${tabs.map(([key, label, href]) => html`<a href="${href}" class="${key === tab ? 'on' : ''}">${label}</a>`)}</nav>
</header>
<main>
${flash ? html`<div class="msg ${flash.error ? 'err' : ''}" role="status">${flash.text}</div>` : ''}
${body}
</main></body></html>`;
  return htmlResponse(page.value);
}

const activePill = (active: number | boolean): Raw =>
  active ? html`<span class="pill ok">Active</span>` : html`<span class="pill">Inactive</span>`;

function rowActions(kind: 'types' | 'reasons' | 'articles', id: number, active: number, what: string): Raw {
  const base = `/admin/kb/${kind}/${id}`;
  return html`<div class="actions">
    <a class="btn" href="${base}">Edit</a>
    <form method="post" action="${base}/toggle"><button>${active ? 'Deactivate' : 'Activate'}</button></form>
    <form method="post" action="${base}/up"><button title="Move up" aria-label="Move up">↑</button></form>
    <form method="post" action="${base}/down"><button title="Move down" aria-label="Move down">↓</button></form>
    <form method="post" action="${base}/delete" onsubmit="return confirm('Delete ${what}? This cannot be undone. Deactivate instead if you might need it again.')">
      <button class="danger">Delete</button></form>
  </div>`;
}

const EVIDENCE_LABEL: Record<string, string> = { required: 'Evidence required', optional: 'Evidence optional', none: 'No evidence' };

// ------------------------------------------------------------------- KB

async function kbPage(env: Env, flash?: { text: string; error?: boolean }): Promise<Response> {
  const [types, articles] = await Promise.all([listTypesWithReasons(env.DB), listArticles(env.DB)]);
  const body = html`
<h2>Transaction types and reasons</h2>
<p class="sub">What staff can do over WhatsApp, the reasons allowed for each, and the process for each reason.
Changes take effect on the next message; nothing needs to be redeployed.</p>
${types.map(
  (t) => html`<div class="card">
  <div class="row"><div class="grow"><h3>${t.name} ${activePill(t.is_active)}</h3>
    <div class="guide">${t.description}</div></div>${rowActions('types', t.id, t.is_active, 'this transaction type and all its reasons')}</div>
  ${t.reasons.map(
    (r) => html`<div class="reason"><div class="row"><div class="grow">
      <strong>${r.label}</strong> ${activePill(r.is_active)}
      <span class="pill">${EVIDENCE_LABEL[r.evidence_rule]}</span>
      ${r.max_days != null ? html`<span class="pill">Max ${r.max_days} days</span>` : ''}
      <div class="guide">${r.process_guide}</div></div>${rowActions('reasons', r.id, r.is_active, 'this reason')}</div></div>`,
  )}
  <div class="reason"><a class="btn" href="/admin/kb/reasons/new?type=${t.id}">+ Add a reason</a></div>
</div>`,
)}
<a class="btn" href="/admin/kb/types/new">+ Add a transaction type</a>

<h2>Articles</h2>
<p class="sub">Reference information the assistant uses to answer general questions: policies, FAQs, contacts.</p>
${articles.map(
  (a) => html`<div class="card"><div class="row"><div class="grow"><h3>${a.title} ${activePill(a.is_active)}</h3>
  ${a.tags ? html`<div class="sub">Tags: ${a.tags}</div>` : ''}<div class="guide">${a.content}</div></div>
  ${rowActions('articles', a.id, a.is_active, 'this article')}</div></div>`,
)}
<a class="btn" href="/admin/kb/articles/new">+ Add an article</a>`;
  return layout('kb', 'Knowledge base', body, flash);
}

const GUIDE_HELP = html`<div class="help"><div><strong>Writing a good process guide</strong></div>
Write it the way you would explain it to a new colleague. The assistant follows it closely, so say:
<ul>
  <li><strong>Who approves, and how.</strong> “Ask your direct supervisor on WhatsApp” is better than “get approval”.</li>
  <li><strong>What to submit, and what it must show.</strong> “A photo of the MC showing your name, the clinic, the dates and the doctor’s signature.”</li>
  <li><strong>Deadlines and limits.</strong> “Within 2 working days of returning to work.” “Not more than 5 days in a row.”</li>
  <li><strong>The steps in order</strong>, numbered if that helps, and any exceptions.</li>
</ul>
If a situation is not covered, the assistant tells the user it is not sure and suggests they ask their supervisor or whoever the guides say to contact. It never makes up a rule.</div>`;

const checkbox = (name: string, checked: boolean, label: string): Raw =>
  html`<label class="check"><input type="checkbox" name="${name}" value="1" ${checked ? raw('checked') : ''}> ${label}</label>`;

const formButtons = html`<p style="margin-top:18px" class="row"><button class="primary">Save</button><a class="btn" href="/admin/kb">Cancel</a></p>`;

function typeForm(action: string, v: { name: string; description: string; process_guide: string; is_active: boolean }, isNew: boolean): Raw {
  return html`<h2>${isNew ? 'Add a transaction type' : `Edit: ${v.name}`}</h2>
<form method="post" action="${action}" class="card">
  <label for="name">Name</label><input id="name" name="name" type="text" value="${v.name}" required maxlength="80" placeholder="e.g. Leave application">
  <label for="description">When does it apply?</label>
  <textarea id="description" name="description" placeholder="Describe in plain words when a staff member would use this.">${v.description}</textarea>
  <label for="process_guide">General process guide</label>
  <textarea id="process_guide" name="process_guide" class="tall" placeholder="Rules that apply whatever the reason, e.g. “apply within 3 working days of returning”.">${v.process_guide}</textarea>
  <p class="hint">Rules for one specific reason belong in that reason’s own guide.</p>
  ${checkbox('is_active', v.is_active, 'Active (staff can use it)')}
  ${isNew ? html`<p class="hint">After saving, add at least one reason. An administrator also needs to set the data fields on the Technical tab.</p>` : ''}
  ${formButtons}
</form>`;
}

function reasonForm(
  action: string,
  typeName: string,
  v: { label: string; process_guide: string; evidence_rule: string; max_days: number | null; is_active: boolean },
  isNew: boolean,
): Raw {
  const option = (value: string, label: string) =>
    html`<option value="${value}" ${v.evidence_rule === value ? raw('selected') : ''}>${label}</option>`;
  return html`<h2>${isNew ? `Add a reason for ${typeName}` : `Edit reason: ${v.label}`}</h2>
${GUIDE_HELP}
<form method="post" action="${action}" class="card">
  <label for="label">Reason</label><input id="label" name="label" type="text" value="${v.label}" required maxlength="80" placeholder="e.g. Medical leave">
  <label for="process_guide">Process guide</label>
  <textarea id="process_guide" name="process_guide" class="tall" placeholder="What this reason covers and the steps the staff member must follow.">${v.process_guide}</textarea>
  <label for="evidence_rule">Evidence</label>
  <select id="evidence_rule" name="evidence_rule">
    ${option('required', 'Required: cannot be submitted without a photo or PDF')}
    ${option('optional', 'Optional: the staff member may send one')}
    ${option('none', 'None: no evidence is needed')}
  </select>
  <label for="max_days">Maximum number of days (optional)</label>
  <input id="max_days" name="max_days" type="number" min="1" step="1" value="${v.max_days ?? ''}" placeholder="Leave empty for no limit">
  <p class="hint">A request for more days than this cannot be submitted. Describe who can approve longer periods in the guide.</p>
  ${checkbox('is_active', v.is_active, 'Active (staff can choose it)')}
  ${formButtons}
</form>`;
}

function articleForm(action: string, v: { title: string; content: string; tags: string; is_active: boolean }, isNew: boolean): Raw {
  return html`<h2>${isNew ? 'Add an article' : `Edit: ${v.title}`}</h2>
<form method="post" action="${action}" class="card">
  <label for="title">Title</label><input id="title" name="title" type="text" value="${v.title}" required maxlength="120">
  <label for="content">Content</label>
  <textarea id="content" name="content" class="tall" placeholder="Plain text. Simple lists with “-” are fine.">${v.content}</textarea>
  <label for="tags">Tags (optional)</label><input id="tags" name="tags" type="text" value="${v.tags}" placeholder="e.g. leave, policy">
  ${checkbox('is_active', v.is_active, 'Active (the assistant can use it)')}
  ${formButtons}
</form>`;
}

const field = (form: FormData, name: string): string => String(form.get(name) ?? '').replace(/\r\n/g, '\n').trim();

const KIND_TABLE: Record<string, KbTable> = { types: 'kb_transaction_types', reasons: 'kb_reasons', articles: 'kb_articles' };

async function kbRoutes(request: Request, env: Env, url: URL, parts: string[]): Promise<Response> {
  const [kind, idPart, action] = parts; // /admin/kb/<kind>/<id|new>/<action?>
  const isPost = request.method === 'POST';
  if (!kind) return kbPage(env, flashFrom(url));

  const table = KIND_TABLE[kind];
  if (!table || !idPart) return notFound();
  const isNew = idPart === 'new';
  const id = isNew ? null : Number.parseInt(idPart, 10);
  if (!isNew && !Number.isInteger(id)) return notFound();

  // Row actions: toggle, move, delete.
  if (action) {
    if (!isPost || id === null) return notFound();
    if (action === 'toggle') {
      const row = await env.DB.prepare(`SELECT is_active FROM ${table} WHERE id = ?`).bind(id).first<{ is_active: number }>();
      if (row) await setActive(env.DB, table, id, !row.is_active);
    } else if (action === 'up' || action === 'down') {
      await moveRow(env.DB, table, id, action);
    } else if (action === 'delete') {
      await deleteRow(env.DB, table, id);
    } else {
      return notFound();
    }
    return redirect('/admin/kb?msg=Saved');
  }

  if (kind === 'types') {
    const existing = id === null ? null : await getType(env.DB, id);
    if (id !== null && !existing) return notFound();
    if (isPost) {
      const form = await request.formData();
      const data = {
        name: field(form, 'name'),
        description: field(form, 'description'),
        process_guide: field(form, 'process_guide'),
        is_active: form.get('is_active') === '1',
      };
      if (!data.name) return layout('kb', 'Transaction type', typeForm(url.pathname, data, isNew), { text: 'Please enter a name.', error: true });
      await saveType(env.DB, id, data);
      return redirect('/admin/kb?msg=Saved');
    }
    const v = existing
      ? { name: existing.name, description: existing.description, process_guide: existing.process_guide, is_active: Boolean(existing.is_active) }
      : { name: '', description: '', process_guide: '', is_active: true };
    return layout('kb', 'Transaction type', typeForm(url.pathname, v, isNew));
  }

  if (kind === 'reasons') {
    const existing = id === null ? null : await getReason(env.DB, id);
    if (id !== null && !existing) return notFound();
    const typeId = existing?.type_id ?? Number.parseInt(url.searchParams.get('type') ?? '', 10);
    const type = Number.isInteger(typeId) ? await getType(env.DB, typeId) : null;
    if (!type) return notFound();
    const formAction = `${url.pathname}${isNew ? `?type=${type.id}` : ''}`;
    if (isPost) {
      const form = await request.formData();
      const rule = field(form, 'evidence_rule');
      const maxDays = Number.parseInt(field(form, 'max_days'), 10);
      const data = {
        type_id: type.id,
        label: field(form, 'label'),
        process_guide: field(form, 'process_guide'),
        evidence_rule: (['required', 'optional', 'none'].includes(rule) ? rule : 'optional') as EvidenceRule,
        max_days: Number.isInteger(maxDays) && maxDays > 0 ? maxDays : null,
        is_active: form.get('is_active') === '1',
      };
      if (!data.label) return layout('kb', 'Reason', reasonForm(formAction, type.name, data, isNew), { text: 'Please enter the reason.', error: true });
      await saveReason(env.DB, id, data);
      return redirect('/admin/kb?msg=Saved');
    }
    const v = existing
      ? {
          label: existing.label,
          process_guide: existing.process_guide,
          evidence_rule: existing.evidence_rule,
          max_days: existing.max_days,
          is_active: Boolean(existing.is_active),
        }
      : { label: '', process_guide: '', evidence_rule: 'optional', max_days: null, is_active: true };
    return layout('kb', 'Reason', reasonForm(formAction, type.name, v, isNew));
  }

  // articles
  const existing = id === null ? null : await getArticle(env.DB, id);
  if (id !== null && !existing) return notFound();
  if (isPost) {
    const form = await request.formData();
    const data = { title: field(form, 'title'), content: field(form, 'content'), tags: field(form, 'tags'), is_active: form.get('is_active') === '1' };
    if (!data.title) return layout('kb', 'Article', articleForm(url.pathname, data, isNew), { text: 'Please enter a title.', error: true });
    await saveArticle(env.DB, id, data);
    return redirect('/admin/kb?msg=Saved');
  }
  const v = existing
    ? { title: existing.title, content: existing.content, tags: existing.tags, is_active: Boolean(existing.is_active) }
    : { title: '', content: '', tags: '', is_active: true };
  return layout('kb', 'Article', articleForm(url.pathname, v, isNew));
}

// ------------------------------------------------------------ technical

function prettyJson(text: string | null): string {
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

async function technicalPage(
  env: Env,
  flash?: { text: string; error?: boolean },
  rejected?: { key: string; text: string },
): Promise<Response> {
  const types = await listTypesWithReasons(env.DB);
  const value = (key: string, stored: string | null) => (rejected?.key === key ? rejected.text : prettyJson(stored));
  const body = html`
<h2>Technical settings</h2>
<p class="sub">For the administrator. These JSON Schemas define the data each request collects and are validated in code.
Business users never need this tab. There are no API or payload settings: every request is submitted through one fixed API call.</p>
<div class="help">Each property may have <code>type</code>, <code>format</code> (use <code>"date"</code> for dates), <code>title</code> (shown to the user in the summary),
<code>description</code> (guidance for the assistant) and standard constraints. List compulsory fields in <code>required</code>.
By convention <code>start_date</code>, <code>end_date</code> and <code>days</code> get consistency checks, and a reason’s maximum days applies to <code>days</code>.</div>
${types.map(
  (t) => html`<div class="card">
  <h3>${t.name} <code>${t.key}</code></h3>
  <form method="post" action="/admin/technical/types/${t.id}">
    <label for="t${t.id}">Fields for every request of this type (<code>fields_schema</code>)</label>
    <textarea id="t${t.id}" name="schema" class="code" spellcheck="false">${value(`t${t.id}`, t.fields_schema)}</textarea>
    <p><button class="primary">Save</button></p>
  </form>
  ${t.reasons.map(
    (r) => html`<div class="reason"><form method="post" action="/admin/technical/reasons/${r.id}">
    <label for="r${r.id}">Extra fields for “${r.label}” <code>${r.code}</code> (optional)</label>
    <textarea id="r${r.id}" name="schema" class="code" spellcheck="false" placeholder="Leave empty for no extra fields">${value(`r${r.id}`, r.extra_fields_schema)}</textarea>
    <p><button class="primary">Save</button></p>
  </form></div>`,
  )}
</div>`,
)}`;
  return layout('technical', 'Technical', body, flash);
}

async function technicalRoutes(request: Request, env: Env, url: URL, parts: string[]): Promise<Response> {
  const [kind, idPart] = parts;
  if (!kind) return technicalPage(env, flashFrom(url));
  const id = Number.parseInt(idPart ?? '', 10);
  if (request.method !== 'POST' || !Number.isInteger(id) || (kind !== 'types' && kind !== 'reasons')) return notFound();

  const text = field(await request.formData(), 'schema');
  const key = `${kind === 'types' ? 't' : 'r'}${id}`;
  if (kind === 'reasons' && !text) {
    await saveReasonSchema(env.DB, id, null);
    return redirect('/admin/technical?msg=Saved');
  }
  const problem = checkSchemaText(text);
  if (problem) return technicalPage(env, { text: `Not saved. ${problem}`, error: true }, { key, text });
  const compact = JSON.stringify(JSON.parse(text));
  if (kind === 'types') await saveTypeSchema(env.DB, id, compact);
  else await saveReasonSchema(env.DB, id, compact);
  return redirect('/admin/technical?msg=Saved');
}

// ------------------------------------------------- drafts (read-only)

const STATUS_PILL: Record<string, string> = {
  collecting: 'warn',
  awaiting_confirmation: 'warn',
  submitted: 'ok',
  failed: 'bad',
  cancelled: '',
  done: 'ok',
  not_done: 'bad',
  not_applicable: '',
  unknown: 'warn',
  confirmed: 'ok',
  unconfirmed: 'warn',
};
const pill = (status: string): Raw => html`<span class="pill ${STATUS_PILL[status] ?? ''}">${status.replace(/_/g, ' ')}</span>`;
const shortTime = (iso: string): string => iso.slice(0, 16).replace('T', ' ');

async function draftsRoutes(env: Env, parts: string[]): Promise<Response> {
  if (parts[0]) {
    const draft = await getDraft(env.DB, parts[0]);
    return draft ? draftPage(env, draft) : notFound();
  }
  const drafts = await listDrafts(env.DB);
  const body = html`<h2>Drafts</h2><p class="sub">Requests in progress and finished ones, newest first. Read-only.</p>
<div class="card scroll">${
    drafts.length
      ? html`<table><thead><tr><th>Updated (UTC)</th><th>Phone</th><th>Type</th><th>Reason</th><th>Status</th><th>Reference</th></tr></thead><tbody>
${drafts.map(
  (d) => html`<tr><td><a href="/admin/drafts/${d.id}">${shortTime(d.updated_at)}</a></td><td><code>${d.phone_number}</code></td>
<td>${d.transaction_type_key}</td><td>${d.reason_code ?? '–'}</td><td>${pill(d.status)}</td><td>${d.target_reference ?? '–'}</td></tr>`,
)}</tbody></table>`
      : html`<p class="sub">No drafts yet.</p>`
  }</div>`;
  return layout('drafts', 'Drafts', body);
}

async function draftPage(env: Env, draft: Draft): Promise<Response> {
  const evidence = await listDraftEvidence(env.DB, draft.id);
  const body = html`<p><a href="/admin/drafts">← All drafts</a></p>
<h2>Draft ${pill(draft.status)}</h2>
<div class="card">
  <div class="sub">Reference <code>${draft.id}</code></div>
  <p>Phone <code>${draft.phone_number}</code> · Type <strong>${draft.transaction_type_key}</strong> ·
     Reason <strong>${draft.reason_code ?? 'not set'}</strong></p>
  ${draft.user_wording ? html`<p>In the user’s words: “${draft.user_wording}”</p>` : ''}
  ${draft.target_reference ? html`<p>Target reference: <code>${draft.target_reference}</code></p>` : ''}
  ${draft.error ? html`<p class="msg err">${draft.error}</p>` : ''}
  <div class="sub">Created ${shortTime(draft.created_at)} UTC · updated ${shortTime(draft.updated_at)} UTC ·
    <a href="/admin/conversations/${draft.conversation_id}">conversation</a></div>
</div>
<h2>Fields</h2>
<div class="card scroll">${
    Object.keys(draft.fields).length
      ? html`<table><thead><tr><th>Field</th><th>Value</th><th>Status</th></tr></thead><tbody>
${Object.entries(draft.fields).map(
  ([name, entry]) => html`<tr><td><code>${name}</code></td><td>${typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value)}</td><td>${pill(entry.status)}</td></tr>`,
)}</tbody></table>`
      : html`<p class="sub">Nothing collected yet.</p>`
  }</div>
<h2>Checklist</h2>
<div class="card scroll">${
    draft.steps.length
      ? html`<table><thead><tr><th>Step</th><th>Status</th><th>How it was verified</th></tr></thead><tbody>
${draft.steps.map((s) => html`<tr><td>${s.text}</td><td>${pill(s.status)}</td><td>${s.note || '–'}</td></tr>`)}</tbody></table>`
      : html`<p class="sub">No checklist yet.</p>`
  }</div>
<h2>Notes</h2>
<div class="card">${
    draft.notes.length
      ? html`<ul>${draft.notes.map((n) => html`<li>${n.text} <span class="sub">(${shortTime(n.at)} UTC)</span></li>`)}</ul>
<p class="sub">Notes are never sent to the target application.</p>`
      : html`<p class="sub">No notes.</p>`
  }</div>
<h2>Evidence</h2>
<div class="card">${
    evidence.length
      ? evidence.map(
          (e) => html`<p><a href="/evidence/${e.id}" target="_blank" rel="noopener">${e.kind === 'image' ? 'Photo' : 'PDF'}${e.filename ? ` · ${e.filename}` : ''}</a>
<span class="sub">${e.mime_type}, ${Math.max(1, Math.round(e.size_bytes / 1024))} KB, received ${shortTime(e.created_at)} UTC</span><br>
${e.summary ?? 'Nothing recorded.'}
${e.extracted_data?.length ? html`<br><span class="sub">${e.extracted_data.map((d) => `${d.name}: ${d.value}`).join(' · ')}</span>` : ''}</p>`,
        )
      : html`<p class="sub">No evidence attached.</p>`
  }</div>`;
  return layout('drafts', 'Draft', body);
}

// ------------------------------------------ conversations (read-only)

const channelPill = (channel: string): Raw =>
  channel === 'mock' ? html`<span class="pill warn">Simulated</span>` : html`<span class="pill ok">WhatsApp</span>`;

async function conversationsRoutes(env: Env, parts: string[]): Promise<Response> {
  if (parts[0]) {
    const conversation = await getConversation(env.DB, Number.parseInt(parts[0], 10) || 0);
    if (!conversation) return notFound();
    const messages = await listMessages(env.DB, conversation.id);
    const body = html`<p><a href="/admin/conversations">← All conversations</a></p>
<h2><code>${conversation.phone_number}</code> ${channelPill(conversation.channel)}</h2>
<div class="card"><div class="chat">${
      messages.length
        ? messages.map(
            (m) => html`<div class="bubble ${m.direction}">${
              m.evidence_id
                ? html`<a href="/evidence/${m.evidence_id}" target="_blank" rel="noopener">📎 ${m.type === 'image' ? 'Photo' : 'PDF'}</a>${m.text ? '\n' : ''}`
                : ''
            }${m.type === 'unsupported' ? '[message that could not be accepted]' : m.text}<small>${shortTime(m.created_at)} UTC${
              m.direction === 'in' && m.status !== 'done' ? ` · ${m.status}` : ''
            }</small></div>`,
          )
        : html`<p class="sub">No messages.</p>`
    }</div></div>`;
    return layout('conversations', 'Conversation', body);
  }
  const rows = await listConversations(env.DB);
  const body = html`<h2>Conversations</h2><p class="sub">Read-only. Simulated chats come from the /mock-wa page.</p>
<div class="card scroll">${
    rows.length
      ? html`<table><thead><tr><th>Phone</th><th>Channel</th><th>Messages</th><th>Last message (UTC)</th></tr></thead><tbody>
${rows.map(
  (c) => html`<tr><td><a href="/admin/conversations/${c.id}"><code>${c.phone_number}</code></a></td><td>${channelPill(c.channel)}</td>
<td>${c.message_count}</td><td>${shortTime(c.last_message_at)}</td></tr>`,
)}</tbody></table>`
      : html`<p class="sub">No conversations yet.</p>`
  }</div>`;
  return layout('conversations', 'Conversations', body);
}

// ------------------------------------------------------------------ demo

async function demoRoutes(request: Request, env: Env, url: URL, parts: string[]): Promise<Response> {
  if (request.method === 'POST') {
    if (parts[0] === 'reset-demo') {
      await seedMockData(env);
      return redirect('/admin/demo?msg=Mock+target+app+data+was+reset');
    }
    if (parts[0] === 'clear-conversations') {
      await clearConversations(env);
      return redirect('/admin/demo?msg=Conversations,+drafts+and+uploaded+files+were+deleted');
    }
    return notFound();
  }
  const body = html`<h2>Demo data</h2>
<div class="card"><h3>Reset demo data</h3>
  <p class="sub">Deletes the mock target app’s records and API log, and makes sure the three built-in demo users exist.
  Test users you added on the <a href="/admin/users">Test users</a> tab are kept. The knowledge base and chats are not touched.</p>
  <form method="post" action="/admin/demo/reset-demo" onsubmit="return confirm('Reset the mock target app data?')"><button class="primary">Reset demo data</button></form>
</div>
<div class="card"><h3>Clear conversations</h3>
  <p class="sub">Deletes every conversation, draft and uploaded evidence file. Use it to start a demo from a clean slate.</p>
  <form method="post" action="/admin/demo/clear-conversations" onsubmit="return confirm('Delete all conversations, drafts and uploaded files?')">
    <button class="danger">Clear conversations, drafts and files</button></form>
</div>`;
  return layout('demo', 'Demo', body, flashFrom(url));
}

// ------------------------------------------------------------ test users

function userInputFrom(form: FormData): UserInput {
  return { phone: field(form, 'phone'), name: field(form, 'name') };
}

async function usersPage(env: Env, flash?: { text: string; error?: boolean }, typed?: UserInput): Promise<Response> {
  const users = await listMockUsers(env.DB);
  const v = typed ?? { phone: '', name: '' };
  const body = html`<h2>Test users</h2>
<p class="sub">People the mock target app knows, identified by their WhatsApp number. A request from a number that is not listed here is
rejected when it is submitted. New users appear in the Mock WhatsApp “You are” list after the page is reloaded.
Leave balances are not kept here: they belong to the HR system, which is outside this prototype.</p>
<div class="help">To use a test user on a <strong>real phone</strong>, the number must also be in the <code>ALLOWED_WHATSAPP_NUMBERS</code> setting
and added as a test recipient in Meta. On Mock WhatsApp any number listed here works straight away.</div>
<form method="post" action="/admin/users/save" class="card">
  <h3>Add a test user</h3>
  <div class="row" style="align-items:flex-end">
    <div class="grow"><label for="phone">WhatsApp number</label>
      <input id="phone" name="phone" type="text" inputmode="numeric" value="${v.phone}" placeholder="6591234567" required></div>
    <div class="grow"><label for="name">Name</label><input id="name" name="name" type="text" value="${v.name}" required maxlength="80"></div>
  </div>
  <p class="hint">International format, digits only, no “+”. Saving a number that already exists renames that user.</p>
  <p><button class="primary">Add user</button></p>
</form>
<div class="card">${
    users.length
      ? html`<h3>Users (${users.length})</h3>
${users.map(
  (u) => html`<div class="reason"><div class="row">
<code>${u.phone_number}</code>
<form class="row grow" method="post" action="/admin/users/save" style="flex-wrap:nowrap">
<input type="hidden" name="phone" value="${u.phone_number}">
<input name="name" type="text" value="${u.name}" required maxlength="80" aria-label="Name for ${u.phone_number}" style="min-width:0">
<button>Save</button></form>
<form method="post" action="/admin/users/delete" onsubmit="return confirm('Remove ${u.name}? Their past records are kept.')">
<input type="hidden" name="phone" value="${u.phone_number}"><button class="danger">Remove</button></form>
</div></div>`,
)}`
      : html`<p class="sub">No users yet.</p>`
  }</div>`;
  return layout('users', 'Test users', body, flash);
}

async function usersRoutes(request: Request, env: Env, url: URL, parts: string[]): Promise<Response> {
  if (request.method !== 'POST') return usersPage(env, flashFrom(url));
  const form = await request.formData();
  if (parts[0] === 'delete') {
    await deleteMockUser(env.DB, field(form, 'phone'));
    return redirect('/admin/users?msg=User+removed');
  }
  if (parts[0] !== 'save') return notFound();
  const input = userInputFrom(form);
  const parsed = parseUserInput(input);
  if ('error' in parsed) return usersPage(env, { text: `Not saved. ${parsed.error}`, error: true }, input);
  await saveMockUser(env.DB, parsed.user);
  return redirect('/admin/users?msg=Saved');
}

// ---------------------------------------------------------------- router

function flashFrom(url: URL): { text: string } | undefined {
  const text = url.searchParams.get('msg');
  return text ? { text: text.slice(0, 200) } : undefined;
}

const notFound = (): Response => new Response('Not found', { status: 404 });

export async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === 'POST' && !isSameOrigin(request)) return new Response('Cross-site request blocked', { status: 403 });
  if (request.method !== 'GET' && request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const [section, ...parts] = url.pathname.split('/').filter(Boolean).slice(1); // drop "admin"
  switch (section) {
    case undefined:
      return redirect('/admin/kb');
    case 'kb':
      return kbRoutes(request, env, url, parts);
    case 'technical':
      return technicalRoutes(request, env, url, parts);
    case 'drafts':
      return draftsRoutes(env, parts);
    case 'conversations':
      return conversationsRoutes(env, parts);
    case 'users':
      return usersRoutes(request, env, url, parts);
    case 'demo':
      return demoRoutes(request, env, url, parts);
    default:
      return notFound();
  }
}
