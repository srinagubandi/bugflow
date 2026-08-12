import { FormEvent, type ReactElement, type ReactNode, useMemo, useState } from 'react';

type Status = 'New' | 'Acknowledged' | 'In Progress' | 'Resolved' | 'Closed';
type Priority = 'Critical' | 'High' | 'Medium' | 'Low';
type View = 'Dashboard' | 'Issues' | 'Projects' | 'Activity';

type Issue = {
  id: string;
  title: string;
  project: string;
  status: Status;
  priority: Priority;
  labels: string[];
  assignee: string;
  reporter: string;
  updated: string;
  comments: number;
  due: string;
  description: string;
};

const issuesSeed: Issue[] = [
  {
    id: 'BF-184',
    title: 'iOS client stops syncing after the app returns from background',
    project: 'Pulse Mobile',
    status: 'In Progress',
    priority: 'Critical',
    labels: ['Mobile', 'Sync'],
    assignee: 'Maya Patel',
    reporter: 'Northstar Health',
    updated: '8m ago',
    comments: 8,
    due: 'Today',
    description: 'Returning to the foreground leaves the event queue disconnected until the customer force-quits the app.',
  },
  {
    id: 'BF-177',
    title: 'Exported CSV omits records filtered by multiple labels',
    project: 'Reporting',
    status: 'Acknowledged',
    priority: 'High',
    labels: ['API', 'Reporting'],
    assignee: 'Jordan Lee',
    reporter: 'Axiom Labs',
    updated: '22m ago',
    comments: 3,
    due: 'Tomorrow',
    description: 'The export endpoint accepts the filter but only respects the first selected label.',
  },
  {
    id: 'BF-172',
    title: 'New team members cannot open shared saved views',
    project: 'Workspace',
    status: 'New',
    priority: 'Medium',
    labels: ['Permissions'],
    assignee: 'Unassigned',
    reporter: 'Orbit Studios',
    updated: '1h ago',
    comments: 1,
    due: 'Fri, Aug 16',
    description: 'Members receive an access error when opening a saved view shared by an organization admin.',
  },
  {
    id: 'BF-169',
    title: 'Screenshot annotations shift when viewed on high-density displays',
    project: 'Console',
    status: 'Resolved',
    priority: 'Medium',
    labels: ['UI'],
    assignee: 'Ana Rivera',
    reporter: 'Kite & Co.',
    updated: '2h ago',
    comments: 5,
    due: 'Completed',
    description: 'Annotation coordinates were calculated from the rendered image width rather than its intrinsic size.',
  },
  {
    id: 'BF-162',
    title: 'Project digest links open the incorrect organization workspace',
    project: 'Notifications',
    status: 'New',
    priority: 'Low',
    labels: ['Email'],
    assignee: 'Maya Patel',
    reporter: 'Summit Partners',
    updated: 'Yesterday',
    comments: 2,
    due: 'Mon, Aug 19',
    description: 'Digest links retain the sender organization rather than the recipient’s selected organization.',
  },
];

const projects = [
  { name: 'Pulse Mobile', color: '#8176ff', count: 18, trend: '+4 this week' },
  { name: 'Workspace', color: '#4dd4a9', count: 11, trend: '+1 this week' },
  { name: 'Reporting', color: '#ef9d54', count: 7, trend: '−2 this week' },
  { name: 'Console', color: '#ec6e8f', count: 5, trend: 'Stable' },
];

const statusOrder: Status[] = ['New', 'Acknowledged', 'In Progress', 'Resolved', 'Closed'];
const priorityOrder: Priority[] = ['Critical', 'High', 'Medium', 'Low'];

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const paths: Record<string, ReactElement> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    bug: <><path d="M9 9h6v6H9z"/><path d="M12 9V6m0 12v-3M9 11H5m4 3H5m10-3h4m-4 3h4M8 7 6 5m10 2 2-2M8 17l-2 2m10-2 2 2"/></>,
    folder: <><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/></>,
    pulse: <path d="M3 12h4l2-6 4 12 2-6h6"/>,
    search: <><circle cx="10.8" cy="10.8" r="6.3"/><path d="m16 16 4.2 4.2"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    bell: <><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
    chevron: <path d="m8 10 4 4 4-4"/>,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6"/>,
    dots: <><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></>,
    filter: <path d="M4 6h16M7 12h10m-7 6h4"/>,
    comment: <path d="M20 15a4 4 0 0 1-4 4H8l-4 3v-7a4 4 0 0 1-1-3V8a4 4 0 0 1 4-4h9a4 4 0 0 1 4 4z"/>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4m8-4v4M3 10h18"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.grid}</svg>;
}

function statusClass(status: Status) {
  return `status status-${status.toLowerCase().replaceAll(' ', '-')}`;
}

function priorityClass(priority: Priority) {
  return `priority priority-${priority.toLowerCase()}`;
}

function Avatar({ name, small = false }: { name: string; small?: boolean }) {
  const initial = name === 'Unassigned' ? '—' : name.split(' ').map((part) => part[0]).join('').slice(0, 2);
  const tone = name === 'Maya Patel' ? 'violet' : name === 'Jordan Lee' ? 'peach' : name === 'Ana Rivera' ? 'mint' : 'slate';
  return <span className={`avatar ${tone} ${small ? 'avatar-small' : ''}`} title={name}>{initial}</span>;
}

export default function App() {
  const [view, setView] = useState<View>('Dashboard');
  const [issues, setIssues] = useState<Issue[]>(issuesSeed);
  const [selected, setSelected] = useState<Issue | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<Status | 'All'>('All');
  const [toast, setToast] = useState('');
  const [profileMenu, setProfileMenu] = useState(false);

  const visibleIssues = useMemo(() => issues.filter((issue) => {
    const needle = query.toLowerCase();
    const matchesQuery = !needle || [issue.id, issue.title, issue.project, issue.assignee, issue.labels.join(' ')].join(' ').toLowerCase().includes(needle);
    const matchesStatus = statusFilter === 'All' || issue.status === statusFilter;
    return matchesQuery && matchesStatus;
  }), [issues, query, statusFilter]);

  const openCount = issues.filter((issue) => !['Resolved', 'Closed'].includes(issue.status)).length;
  const dueSoon = issues.filter((issue) => issue.due === 'Today' || issue.due === 'Tomorrow').length;
  const critical = issues.filter((issue) => issue.priority === 'Critical' && !['Resolved', 'Closed'].includes(issue.status)).length;

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2600);
  };

  const createIssue = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newIssue: Issue = {
      id: `BF-${Math.floor(185 + Math.random() * 80)}`,
      title: String(form.get('title') || 'Untitled report'),
      project: String(form.get('project') || 'Workspace'),
      status: 'New',
      priority: String(form.get('priority') || 'Medium') as Priority,
      labels: ['Needs triage'],
      assignee: 'Unassigned',
      reporter: 'Your organization',
      updated: 'Just now',
      comments: 0,
      due: 'Not set',
      description: String(form.get('description') || 'No details provided.'),
    };
    setIssues((current) => [newIssue, ...current]);
    setShowCreate(false);
    setView('Issues');
    notify(`${newIssue.id} was created and added to triage.`);
  };

  const moveIssue = (issue: Issue, status: Status) => {
    setIssues((current) => current.map((entry) => entry.id === issue.id ? { ...entry, status, updated: 'Just now' } : entry));
    setSelected((current) => current ? { ...current, status, updated: 'Just now' } : current);
    notify(`${issue.id} moved to ${status}.`);
  };

  const navItems: { label: View; icon: string; badge?: number }[] = [
    { label: 'Dashboard', icon: 'grid' },
    { label: 'Issues', icon: 'bug', badge: openCount },
    { label: 'Projects', icon: 'folder' },
    { label: 'Activity', icon: 'pulse' },
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark"><span></span><span></span><span></span></div>
          <span>BugFlow</span>
          <button className="icon-button sidebar-collapse" aria-label="Collapse navigation"><Icon name="chevron" size={14} /></button>
        </div>

        <button className="organization-switcher" onClick={() => notify('Organization switcher is ready for your connected organizations.')}>
          <span className="org-logo">N</span>
          <span className="organization-copy"><strong>Northstar</strong><small>Product operations</small></span>
          <Icon name="chevron" size={14} />
        </button>

        <nav className="primary-nav" aria-label="Workspace navigation">
          {navItems.map((item) => (
            <button key={item.label} className={`nav-item ${view === item.label ? 'active' : ''}`} onClick={() => setView(item.label)}>
              <Icon name={item.icon} size={17} />
              <span>{item.label}</span>
              {item.badge ? <span className="nav-badge">{item.badge}</span> : null}
            </button>
          ))}
        </nav>

        <div className="nav-section">
          <div className="section-title"><span>Projects</span><button onClick={() => notify('Create a project from the Projects view.')} aria-label="Create project"><Icon name="plus" size={14} /></button></div>
          {projects.map((project) => (
            <button className="project-nav" key={project.name} onClick={() => { setView('Issues'); setQuery(project.name); }}>
              <i style={{ background: project.color }}></i><span>{project.name}</span><em>{project.count}</em>
            </button>
          ))}
        </div>

        <div className="sidebar-footer">
          <button className="help-link" onClick={() => notify('Help center link copied to your workspace menu.')}><span className="help-dot">?</span> Help & resources</button>
          <button className="user-chip" onClick={() => setProfileMenu((current) => !current)}>
            <Avatar name="Maya Patel" />
            <span><strong>Maya Patel</strong><small>Organization admin</small></span>
            <Icon name="dots" size={17} />
          </button>
          {profileMenu ? <div className="profile-menu"><button onClick={() => notify('Account settings would open here.')}>Account settings</button><button onClick={() => notify('You are already in Northstar.')}>Switch organization</button></div> : null}
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <button className="mobile-menu"><Icon name="grid" /></button>
          <label className="search-box">
            <Icon name="search" size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search bugs, projects, people…" />
            <kbd>⌘ K</kbd>
          </label>
          <div className="top-actions">
            <button className="icon-button" onClick={() => notify('You have 3 unread notifications.')} aria-label="Notifications"><Icon name="bell" size={18} /><i className="notification-dot"></i></button>
            <button className="new-report" onClick={() => setShowCreate(true)}><Icon name="plus" size={16} /> New report</button>
          </div>
        </header>

        {view === 'Dashboard' && <Dashboard issues={issues} openCount={openCount} critical={critical} dueSoon={dueSoon} onSelect={setSelected} onViewIssues={() => setView('Issues')} />}
        {view === 'Issues' && <IssuesView issues={visibleIssues} statusFilter={statusFilter} onStatusFilter={setStatusFilter} onSelect={setSelected} onCreate={() => setShowCreate(true)} />}
        {view === 'Projects' && <ProjectsView onProject={(name) => { setView('Issues'); setQuery(name); }} />}
        {view === 'Activity' && <ActivityView />}
      </main>

      {selected ? <IssueDrawer issue={selected} onClose={() => setSelected(null)} onMove={moveIssue} onNotify={notify} /> : null}
      {showCreate ? <CreateReportModal onClose={() => setShowCreate(false)} onCreate={createIssue} /> : null}
      {toast ? <div className="toast"><Icon name="check" size={16} /> {toast}</div> : null}
    </div>
  );
}

function Dashboard({ issues, openCount, critical, dueSoon, onSelect, onViewIssues }: { issues: Issue[]; openCount: number; critical: number; dueSoon: number; onSelect: (issue: Issue) => void; onViewIssues: () => void }) {
  const inProgress = issues.filter((issue) => issue.status === 'In Progress').length;
  const recentlyUpdated = issues.slice(0, 4);
  return <div className="page dashboard-page">
    <div className="page-intro">
      <div><p className="eyebrow">Tuesday, August 12</p><h1>Good morning, Maya</h1><p className="subtle">Here’s the current signal across Northstar’s product work.</p></div>
      <button className="text-button" onClick={onViewIssues}>View all issues <Icon name="arrow" size={15} /></button>
    </div>

    <section className="metric-grid">
      <MetricCard label="Open reports" value={String(openCount)} detail="Across 4 active projects" tone="violet" icon="bug" />
      <MetricCard label="Needs attention" value={String(critical)} detail="Critical priority" tone="rose" icon="bell" />
      <MetricCard label="Due soon" value={String(dueSoon)} detail="Within the next 24 hours" tone="gold" icon="calendar" />
      <MetricCard label="In progress" value={String(inProgress)} detail="Assigned to your team" tone="mint" icon="pulse" />
    </section>

    <section className="dashboard-grid">
      <div className="panel trend-panel">
        <div className="panel-heading"><div><span className="panel-kicker">Report volume</span><h2>Issue flow</h2></div><button className="period-pill">Last 14 days <Icon name="chevron" size={14} /></button></div>
        <div className="chart-summary"><strong>42</strong><span>reports created</span><span className="positive">+18.2%</span></div>
        <div className="line-chart" aria-label="Issue flow chart"><svg viewBox="0 0 620 180" preserveAspectRatio="none"><defs><linearGradient id="area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#8278ff" stopOpacity=".32"/><stop offset="1" stopColor="#8278ff" stopOpacity="0"/></linearGradient></defs><path className="chart-area" d="M0,144 C42,135 54,102 92,117 C130,132 147,80 185,91 C220,102 241,118 278,92 C318,63 329,100 366,77 C402,55 426,68 461,42 C492,20 531,78 558,48 C586,18 598,32 620,15 L620,180 L0,180 Z"/><path className="chart-line" d="M0,144 C42,135 54,102 92,117 C130,132 147,80 185,91 C220,102 241,118 278,92 C318,63 329,100 366,77 C402,55 426,68 461,42 C492,20 531,78 558,48 C586,18 598,32 620,15"/><circle cx="461" cy="42" r="4" className="chart-dot"/></svg><div className="chart-axis"><span>Jul 30</span><span>Aug 2</span><span>Aug 5</span><span>Aug 8</span><span>Today</span></div></div>
      </div>
      <div className="panel distribution-panel">
        <div className="panel-heading"><div><span className="panel-kicker">At a glance</span><h2>By status</h2></div><button className="icon-button muted"><Icon name="dots" size={17} /></button></div>
        <div className="donut-layout"><div className="donut"><div><strong>{openCount}</strong><span>open</span></div></div><div className="status-list"><StatusRow color="#7e75ff" label="New" value={issues.filter((i) => i.status === 'New').length} /><StatusRow color="#e9b45d" label="Acknowledged" value={issues.filter((i) => i.status === 'Acknowledged').length} /><StatusRow color="#46c9a1" label="In progress" value={issues.filter((i) => i.status === 'In Progress').length} /><StatusRow color="#7790ab" label="Resolved" value={issues.filter((i) => i.status === 'Resolved').length} /></div></div>
      </div>
    </section>

    <section className="dashboard-grid lower-grid">
      <div className="panel reports-panel"><div className="panel-heading"><div><span className="panel-kicker">Triage queue</span><h2>Recently updated</h2></div><button className="text-button compact" onClick={onViewIssues}>See queue <Icon name="arrow" size={14} /></button></div><div className="issue-list compact-list">{recentlyUpdated.map((issue) => <IssueRow issue={issue} key={issue.id} onSelect={onSelect} />)}</div></div>
      <div className="panel project-panel"><div className="panel-heading"><div><span className="panel-kicker">Projects</span><h2>Project health</h2></div><button className="icon-button muted"><Icon name="dots" size={17} /></button></div><div className="project-health">{projects.map((project) => <div className="health-row" key={project.name}><div className="health-name"><i style={{ background: project.color }}></i><span>{project.name}</span></div><div className="health-bar"><b style={{ width: `${Math.max(22, project.count * 4)}%`, background: project.color }}></b></div><span>{project.count}</span></div>)}</div></div>
    </section>
  </div>;
}

function MetricCard({ label, value, detail, tone, icon }: { label: string; value: string; detail: string; tone: string; icon: string }) {
  return <div className={`metric-card ${tone}`}><div className="metric-icon"><Icon name={icon} size={17} /></div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function StatusRow({ color, label, value }: { color: string; label: string; value: number }) {
  return <div className="status-row"><i style={{ background: color }}></i><span>{label}</span><strong>{value}</strong></div>;
}

function IssuesView({ issues, statusFilter, onStatusFilter, onSelect, onCreate }: { issues: Issue[]; statusFilter: Status | 'All'; onStatusFilter: (status: Status | 'All') => void; onSelect: (issue: Issue) => void; onCreate: () => void }) {
  return <div className="page issues-page">
    <div className="page-intro"><div><p className="eyebrow">Northstar / All projects</p><h1>Issues</h1><p className="subtle">Track, discuss, and resolve every customer-reported problem.</p></div><button className="new-report" onClick={onCreate}><Icon name="plus" size={16} /> New report</button></div>
    <div className="issues-toolbar"><div className="filter-group"><button className="filter-button"><Icon name="filter" size={15} /> Filters <span>0</span></button><div className="status-tabs">{(['All', ...statusOrder] as const).map((status) => <button key={status} onClick={() => onStatusFilter(status)} className={statusFilter === status ? 'selected' : ''}>{status}</button>)}</div></div><button className="view-toggle"><span></span><span></span><span></span></button></div>
    <div className="issues-table panel"><div className="table-head"><span>Issue</span><span>Status</span><span>Priority</span><span>Project</span><span>Assignee</span><span>Updated</span></div><div className="issue-list">{issues.length ? issues.map((issue) => <IssueRow issue={issue} key={issue.id} onSelect={onSelect} detailed />) : <div className="empty-state"><Icon name="search" size={28} /><h3>No reports found</h3><p>Try adjusting your search or status filter.</p></div>}</div></div>
  </div>;
}

function IssueRow({ issue, onSelect, detailed = false }: { issue: Issue; onSelect: (issue: Issue) => void; detailed?: boolean }) {
  return <button className={`issue-row ${detailed ? 'detailed-row' : ''}`} onClick={() => onSelect(issue)}><div className="issue-primary"><span className={priorityClass(issue.priority)}></span><div><div className="issue-title-line"><strong>{issue.id}</strong><h3>{issue.title}</h3></div><div className="issue-meta"><span>{issue.labels.map((label) => <em key={label}>{label}</em>)}</span>{!detailed ? <><span className="dot-separator">•</span><span>{issue.project}</span></> : null}</div></div></div>{detailed ? <><span><b className={statusClass(issue.status)}>{issue.status}</b></span><span className="priority-text">{issue.priority}</span><span>{issue.project}</span><span className="assignee-cell"><Avatar name={issue.assignee} small /> {issue.assignee}</span><span>{issue.updated}</span></> : <div className="compact-info"><b className={statusClass(issue.status)}>{issue.status}</b><Avatar name={issue.assignee} small /><span>{issue.updated}</span></div>}</button>;
}

function ProjectsView({ onProject }: { onProject: (project: string) => void }) {
  return <div className="page projects-page"><div className="page-intro"><div><p className="eyebrow">Northstar workspace</p><h1>Projects</h1><p className="subtle">Organize bug reporting around the work your customers rely on.</p></div><button className="new-report" onClick={() => {}}><Icon name="plus" size={16} /> New project</button></div><div className="projects-grid">{projects.map((project, index) => <button className="project-card" key={project.name} onClick={() => onProject(project.name)}><div className="project-card-top"><span className="project-symbol" style={{ color: project.color, borderColor: `${project.color}55` }}>{project.name.slice(0, 1)}</span><Icon name="arrow" size={16} /></div><h2>{project.name}</h2><p>{index === 0 ? 'Customer-facing mobile experiences and incident reports.' : index === 1 ? 'Shared workspaces, membership, and access controls.' : index === 2 ? 'Analytics exports, dashboards, and reporting APIs.' : 'The administration console and team workflows.'}</p><div className="project-card-bottom"><span><b>{project.count}</b> open reports</span><em style={{ color: project.color }}>{project.trend}</em></div></button>)}</div></div>;
}

function ActivityView() {
  return <div className="page activity-page"><div className="page-intro"><div><p className="eyebrow">Northstar workspace</p><h1>Activity</h1><p className="subtle">A tamper-evident timeline of work, access, and customer communication.</p></div><button className="filter-button"><Icon name="filter" size={15} /> All activity</button></div><div className="activity-panel panel"><div className="activity-day">Today</div><ActivityItem actor="Maya Patel" action="moved BF-184 to In Progress" context="Pulse Mobile" tone="violet" /><ActivityItem actor="Jordan Lee" action="posted a customer-visible update" context="BF-177" tone="peach" /><ActivityItem actor="System" action="sent a status-update email to Axiom Labs" context="Delivery confirmed" tone="slate" /><div className="activity-day">Yesterday</div><ActivityItem actor="Ana Rivera" action="resolved BF-169" context="Console" tone="mint" /><ActivityItem actor="Maya Patel" action="granted customer access to Reporting" context="Axiom Labs" tone="violet" /></div></div>;
}

function ActivityItem({ actor, action, context, tone }: { actor: string; action: string; context: string; tone: string }) {
  return <div className="activity-item"><Avatar name={actor === 'System' ? 'System' : actor} small /><div><p><strong>{actor}</strong> {action}</p><span>{context} <b>·</b> {actor === 'System' ? 'Yesterday at 4:21 PM' : 'Today at 10:42 AM'}</span></div><button className="icon-button muted"><Icon name="dots" size={16} /></button></div>;
}

function IssueDrawer({ issue, onClose, onMove, onNotify }: { issue: Issue; onClose: () => void; onMove: (issue: Issue, status: Status) => void; onNotify: (message: string) => void }) {
  const [comment, setComment] = useState('');
  const [internal, setInternal] = useState(false);
  return <div className="overlay" role="dialog" aria-modal="true" aria-label={`Issue ${issue.id}`}><div className="issue-drawer"><header className="drawer-header"><div className="drawer-breadcrumb"><span>{issue.project}</span><b>/</b><strong>{issue.id}</strong></div><div><button className="icon-button muted" onClick={() => onNotify('Issue link copied to clipboard.')}>↗</button><button className="icon-button muted" onClick={onClose} aria-label="Close issue"><Icon name="close" size={18} /></button></div></header><div className="drawer-content"><div className="issue-main"><div className="issue-detail-title"><span className={priorityClass(issue.priority)}></span><h1>{issue.title}</h1></div><div className="detail-chips"><b className={statusClass(issue.status)}>{issue.status}</b><span className="detail-chip"><Icon name="lock" size={13} /> Customer visible</span></div><div className="description"><h3>Description</h3><p>{issue.description}</p><h3>Expected result</h3><p>The experience should preserve the current customer session and resume normally without a manual recovery step.</p></div><div className="divider"></div><div className="conversation-heading"><div><h3>Activity & discussion</h3><p>Customer-visible updates are sent by email automatically.</p></div><button className="watch-button" onClick={() => onNotify('You are now watching this report.')}><Icon name="bell" size={14} /> Watching</button></div><div className="comment-thread"><Comment author="Maya Patel" time="8 minutes ago" body="We reproduced this on iOS 18.5 and have assigned the investigation to the mobile team." /><Comment author="Northstar Health" time="31 minutes ago" body="Thank you. We can provide a screen recording if that would help your team." customer /></div><form className="comment-box" onSubmit={(event) => { event.preventDefault(); if (comment.trim()) { onNotify(internal ? 'Internal note added.' : 'Customer update sent.'); setComment(''); } }}><textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder={internal ? 'Write an internal note…' : 'Write a customer-visible update…'} /><div><button type="button" className={`visibility-toggle ${internal ? 'internal' : ''}`} onClick={() => setInternal((current) => !current)}><Icon name={internal ? 'lock' : 'comment'} size={13} /> {internal ? 'Internal only' : 'Customer visible'}</button><div><button type="button" className="icon-button muted" onClick={() => onNotify('Attachment picker would open here.')}><Icon name="plus" size={16} /></button><button className="send-button" type="submit">Send <Icon name="arrow" size={14} /></button></div></div></form></div><aside className="issue-properties"><Property label="Status"><select value={issue.status} onChange={(event) => onMove(issue, event.target.value as Status)}>{statusOrder.map((status) => <option key={status}>{status}</option>)}</select></Property><Property label="Priority"><span className="property-value"><span className={priorityClass(issue.priority)}></span>{issue.priority}</span></Property><Property label="Assignee"><span className="property-value"><Avatar name={issue.assignee} small />{issue.assignee}</span></Property><Property label="Project"><span className="property-value"><i className="mini-project-dot"></i>{issue.project}</span></Property><Property label="Due date"><span className="property-value"><Icon name="calendar" size={14} />{issue.due}</span></Property><Property label="Labels"><div className="label-stack">{issue.labels.map((label) => <em key={label}>{label}</em>)}</div></Property><div className="property-divider"></div><button className="danger-link" onClick={() => onNotify('This report would be soft-deleted and remains recoverable by an administrator.')}>Soft-delete report</button></aside></div></div></div>;
}

function Property({ label, children }: { label: string; children: ReactNode }) { return <div className="property"><span>{label}</span>{children}</div>; }
function Comment({ author, time, body, customer = false }: { author: string; time: string; body: string; customer?: boolean }) { return <div className="comment"><Avatar name={author} small /><div><p><strong>{author}</strong>{customer ? <em>Customer</em> : null}<span>{time}</span></p><div>{body}</div></div></div>; }

function CreateReportModal({ onClose, onCreate }: { onClose: () => void; onCreate: (event: FormEvent<HTMLFormElement>) => void }) {
  return <div className="overlay" role="dialog" aria-modal="true" aria-label="New bug report"><form className="create-modal" onSubmit={onCreate}><header><div><p className="eyebrow">New report</p><h2>Capture a bug clearly</h2></div><button type="button" className="icon-button muted" onClick={onClose}><Icon name="close" size={18} /></button></header><label>Title<input required name="title" autoFocus placeholder="What happened?" /></label><div className="form-two"><label>Project<select name="project">{projects.map((project) => <option key={project.name}>{project.name}</option>)}</select></label><label>Priority<select name="priority">{priorityOrder.map((priority) => <option key={priority} selected={priority === 'Medium'}>{priority}</option>)}</select></label></div><label>Description<textarea required name="description" placeholder="Include steps to reproduce, expected result, actual result, browser/device, and app version." /></label><div className="upload-well"><Icon name="plus" size={18} /><div><strong>Add evidence</strong><span>Drop screenshots, recordings, or files here</span></div><button type="button">Browse</button></div><footer><button type="button" className="cancel-button" onClick={onClose}>Cancel</button><button className="send-button" type="submit">Create report <Icon name="arrow" size={14} /></button></footer></form></div>;
}
