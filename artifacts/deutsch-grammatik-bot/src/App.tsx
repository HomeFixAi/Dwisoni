import { type ButtonHTMLAttributes, type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ClerkProvider, Show, SignIn, SignUp, useClerk, useUser } from '@clerk/react';
import { shadcn } from '@clerk/themes';
import {
  Activity, ArrowLeft, ArrowRight, BookOpen,
  Bot, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Clock3,
  Copy, FileText, LayoutDashboard, Link2, LoaderCircle, LogOut,
  Menu, MessageCircle, Pencil, Plus, RefreshCw, Settings2,
  ShieldCheck, Sparkles, Trash2, Trophy, Users, X, Zap,
} from 'lucide-react';
import {
  Route, Switch, Redirect, Link, Router as WouterRouter, useLocation,
} from 'wouter';
import {
  getGetQuizBotAccessQueryKey, getGetQuizBotDashboardQueryKey,
  getGetQuizBotSettingsQueryKey, getGetTelegramBotStatusQueryKey,
  getGetQuizParticipantQueryKey, getGetQuizSessionQueryKey,
  getGetQuizLeaderboardQueryKey, getListQuizParticipantsQueryKey,
  getListQuizSessionsQueryKey, getListQuizTopicsQueryKey,
  useCreateTelegramAdminLinkCode, useCreateQuizTopic, useDeleteQuizTopic,
  useGetQuizBotAccess, useGetQuizBotDashboard, useGetQuizBotSettings,
  useGetQuizParticipant, useGetQuizSession, useGetQuizLeaderboard,
  useGetTelegramBotStatus, useListQuizParticipants, useListQuizSessions,
  useListQuizTopics, useTestTelegramBotConnection, useUpdateQuizBotSettings,
  useUpdateQuizTopic,
} from '@workspace/api-client-react';
import type { BotSettings, QuizTopic, QuizTopicInput, QuizTopicUpdate } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
// @clerk/react 5.54 no longer exposes the host resolver from its internal entrypoint.
// Keep the same host-aware call surface so deployments can provide a domain-specific key resolver.
function publishableKeyFromHost(_hostname: string, key?: string) { return key; }
const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
if (!clerkPubKey) throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
function stripBase(path: string) { return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path; }

const appearance = {
  theme: shadcn, cssLayerName: 'clerk',
  options: { logoPlacement: 'inside' as const, logoLinkUrl: basePath || '/', logoImageUrl: `${window.location.origin}${basePath}/logo.svg` },
  variables: {
    colorPrimary: '#315b4d', colorForeground: '#29384a', colorMutedForeground: '#65717e',
    colorDanger: '#b94d43', colorBackground: '#fbf9f2', colorInput: '#fffdf8',
    colorInputForeground: '#29384a', colorNeutral: '#ddd8cc', fontFamily: 'DM Sans',
    borderRadius: '0.8rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-[#fbf9f2] rounded-2xl w-[440px] max-w-full overflow-hidden shadow-xl',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-[#29384a] font-bold', headerSubtitle: 'text-[#65717e]',
    socialButtonsBlockButtonText: 'text-[#29384a]', formFieldLabel: 'text-[#29384a]',
    footerActionLink: 'text-[#315b4d]', footerActionText: 'text-[#65717e]',
    dividerText: 'text-[#65717e]', identityPreviewEditButton: 'text-[#315b4d]',
    formFieldSuccessText: 'text-[#315b4d]', alertText: 'text-[#29384a]',
    logoBox: 'rounded-xl overflow-hidden', logoImage: 'rounded-xl',
    socialButtonsBlockButton: 'border-[#ddd8cc] bg-[#fffdf8]',
    formButtonPrimary: 'bg-[#315b4d] hover:bg-[#25483c]',
    formFieldInput: 'border-[#ddd8cc] bg-[#fffdf8] text-[#29384a]',
    footerAction: 'text-[#65717e]', dividerLine: 'bg-[#ddd8cc]',
    alert: 'border-[#ddd8cc]', otpCodeFieldInput: 'border-[#ddd8cc]',
    formFieldRow: 'text-[#29384a]', main: 'text-[#29384a]',
  },
};

type IconType = typeof LayoutDashboard;
const navItems: { href: string; label: string; icon: IconType }[] = [
  { href: '/dashboard', label: 'Umumiy ko‘rinish', icon: LayoutDashboard },
  { href: '/topics', label: 'Mavzular', icon: BookOpen },
  { href: '/history', label: 'Testlar tarixi', icon: Activity },
  { href: '/participants', label: 'Ishtirokchilar', icon: Users },
  { href: '/settings', label: 'Sozlamalar', icon: Settings2 },
];
const fmtDate = (value?: string | null, options?: Intl.DateTimeFormatOptions) => value
  ? new Intl.DateTimeFormat('uz-UZ', options ?? { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value))
  : '—';
const fmtTime = (value?: string | null) => value ? new Intl.DateTimeFormat('uz-UZ', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';
const fmtTimeInZone = (value: string | null | undefined, timeZone: string) => value ? new Intl.DateTimeFormat('uz-UZ', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value)) : '—';
const statusText: Record<string, string> = { signup: 'Ro‘yxatdan o‘tish', generating: 'Tayyorlanmoqda', running: 'Jarayonda', completed: 'Yakunlangan', cancelled: 'Bekor qilingan', planned: 'Rejada', announcing: 'E’lon qilinmoqda', announced: 'E’lon qilingan', preview: 'Preview', used: 'Ishlatilgan' };

function Button({ children, variant = 'primary', className = '', 'data-testid': testId, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'outline' | 'quiet' | 'danger'; 'data-testid'?: string }) {
  return <button {...props} className={`button button-${variant} ${className}`} data-testid={testId}>{children}</button>;
}
function PageTitle({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-title page-enter"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action && <div className="title-action">{action}</div>}</div>;
}
function Card({ children, className = '' }: { children: ReactNode; className?: string }) { return <section className={`surface ${className}`}>{children}</section>; }
function Loading({ label = 'Ma’lumotlar yuklanmoqda' }: { label?: string }) {
  return <div className="loading-panel"><div className="skeleton skeleton-title" /><div className="skeleton skeleton-line" /><div className="skeleton skeleton-line short" /><span className="loading-label"><LoaderCircle size={15} className="spin" />{label}</span></div>;
}
function ErrorState({ onRetry, message = 'Ma’lumotlarni yuklab bo‘lmadi. Ulanishni tekshirib, qayta urinib ko‘ring.' }: { onRetry: () => void; message?: string }) {
  return <div className="state-panel"><div className="state-icon state-error"><CircleHelp size={21} /></div><h3>Bir oz to‘xtab qoldik</h3><p>{message}</p><Button variant="outline" onClick={onRetry}><RefreshCw size={15} /> Qayta urinish</Button></div>;
}
function EmptyState({ icon: Icon = FileText, title, body, action }: { icon?: IconType; title: string; body: string; action?: ReactNode }) {
  return <div className="state-panel"><div className="state-icon"><Icon size={22} /></div><h3>{title}</h3><p>{body}</p>{action}</div>;
}
function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) { return <span className={`badge badge-${tone}`}>{children}</span>; }
function Metric({ label, value, foot, icon: Icon, tone = 'gold' }: { label: string; value: ReactNode; foot: string; icon: IconType; tone?: string }) {
  return <Card className="metric-card"><div className={`metric-icon ${tone}`}><Icon size={18} /></div><div className="metric-label">{label}</div><div className="metric-value">{value}</div><div className="metric-foot">{foot}</div></Card>;
}
function PublicHome() {
  return <main className="welcome">
    <div className="welcome-nav"><Link href="/" className="brand"><img src={`${basePath}/logo.svg`} alt="" /><span>Deutsch<span className="brand-light">Grammatik</span></span></Link><Link href="/sign-in" className="text-link">Administrator sifatida kirish <ArrowRight size={16} /></Link></div>
    <div className="welcome-hero">
      <div className="welcome-copy page-enter"><div className="kicker"><span className="kicker-dot" /> O‘N KISHILIK GURUH UCHUN O‘QUV BOTI</div><h1>Grammatika.<br /><em>Har kuni.</em><br />Birga.</h1><p>Grammatik Aktiv asosidagi qisqa testlar, aniq natijalar va kunlik ritm — barchasi Telegram guruhingiz uchun.</p><div className="welcome-actions"><Link href="/sign-in" className="button button-primary">Boshqaruvga kirish <ArrowRight size={16} /></Link><span className="quiet-caption"><ShieldCheck size={15} /> Faqat guruh administratorlari uchun</span></div></div>
      <div className="lesson-art" aria-label="Nemis grammatikasi o‘quv kartasi"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="book-card"><div className="book-top"><span>GRAMMATIK AKTIV</span><span className="mono">A2–B1</span></div><div className="article-mark"><i>der</i><i>die</i><i>das</i></div><div className="book-rule" /><div className="book-example"><span>Ich lerne</span><b>Deutsch.</b></div><div className="book-footer"><span>Ein Schritt jeden Tag.</span><span className="page-number">01 / 10</span></div></div><div className="floating-note"><span className="note-mark">A</span><div><b>Bugungi ritm</b><small>1 mavzu · 10 savol</small></div><CheckCircle2 size={18} /></div><div className="stamp">GUT<br />GEMACHT</div></div>
    </div>
    <div className="welcome-bottom"><span>O‘RGANISH TARTIBI</span><div className="welcome-steps"><div><b>01</b><span>Mavzu belgilanadi</span></div><div><b>02</b><span>Bot savol beradi</span></div><div><b>03</b><span>Natijalar jamlanadi</span></div></div><span className="welcome-footnote">Deutsch Grammatik Test Bot <i>·</i> 2025</span></div>
  </main>;
}

function AuthPage({ signup = false }: { signup?: boolean }) {
  return <main className="auth-wrap"><div className="auth-side"><Link href="/" className="brand"><img src={`${basePath}/logo.svg`} alt="" /><span>Deutsch<span className="brand-light">Grammatik</span></span></Link><div><div className="eyebrow">GURUH UCHUN O‘QUV BOSHQARUVI</div><h1>Har bir qoida<br /><em>o‘z o‘rnida.</em></h1><p>Testlar, jadval va natijalar — o‘quv jarayonining barcha muhim nuqtalari bir joyda.</p></div><div className="auth-proof"><span className="proof-mark">§</span><span>Grammatik Aktiv<br /><small>Aniq qoidalar. Barqaror odat.</small></span></div></div><div className="auth-form"><Link href="/" className="back-home"><ArrowLeft size={15} /> Bosh sahifa</Link>{signup ? <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /> : <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />}</div></main>;
}

function ClerkCacheSync() {
  const { addListener } = useClerk(); const qc = useQueryClient(); const prior = useRef<string | null | undefined>(undefined);
  useEffect(() => addListener(({ user }) => { const id = user?.id ?? null; if (prior.current !== undefined && prior.current !== id) qc.clear(); prior.current = id; }), [addListener, qc]);
  return null;
}
function Layout({ children, active }: { children: ReactNode; active: string }) {
  const { user } = useUser(); const { signOut } = useClerk(); const [mobileNav, setMobileNav] = useState(false);
  const initials = (user?.firstName?.[0] ?? user?.primaryEmailAddress?.emailAddress?.[0] ?? 'A').toUpperCase();
  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
      <Link href="/dashboard" className="brand side-brand"><img src={`${basePath}/logo.svg`} alt="" /><span>Deutsch<span className="brand-light">Grammatik</span></span></Link>
      <div className="group-label">O‘QUV JARAYONI</div><nav>{navItems.map(({ href, label, icon: Icon }) => <Link key={href} href={href} onClick={() => setMobileNav(false)} className={`nav-link ${active === href ? 'nav-active' : ''}`} data-testid={`link-nav-${href.slice(1)}`}><Icon size={17} /><span>{label}</span>{active === href && <span className="nav-indicator" />}</Link>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-status"><span className="status-pulse" /><div><b>O‘quv maydoni</b><small>Grammatik Aktiv · A2–B1</small></div></div><div className="profile-row"><span className="profile-avatar">{initials}</span><span className="profile-name">{user?.firstName || 'Administrator'}<small>{user?.primaryEmailAddress?.emailAddress ?? 'Guruh admini'}</small></span><button className="icon-button profile-out" aria-label="Chiqish" onClick={() => signOut({ redirectUrl: basePath || '/' })}><LogOut size={16} /></button></div></div>
    </aside>
    {mobileNav && <button aria-label="Menyuni yopish" className="mobile-scrim" onClick={() => setMobileNav(false)} />}
    <div className="main-column"><header className="topbar"><button className="icon-button mobile-menu" aria-label="Menyuni ochish" onClick={() => setMobileNav(!mobileNav)}><Menu size={20} /></button><div className="breadcrumb"><span>Grammatik Aktiv</span><ChevronRight size={14} /><b>{navItems.find(n => n.href === active)?.label ?? 'Boshqaruv'}</b></div><div className="topbar-right"><span className="topbar-date">{new Intl.DateTimeFormat('uz-UZ', { weekday: 'short', day: 'numeric', month: 'long' }).format(new Date())}</span><span className="top-avatar">{initials}</span></div></header><main className="content">{children}</main><footer className="app-footer"><span><span className="footer-mark">§</span> Deutsch Grammatik Test Bot</span><span>O‘rganish jarayoni boshqaruvi <i>·</i> v1.0</span></footer></div>
  </div>;
}

function AccessGate({ children }: { children: ReactNode }) {
  const access = useGetQuizBotAccess({ query: { queryKey: getGetQuizBotAccessQueryKey() } });
  if (access.isLoading) return <div className="gate"><Loading label="Ruxsat tekshirilmoqda" /></div>;
  if (access.isError) return <div className="gate"><ErrorState onRetry={() => access.refetch()} message="Hisobingiz holatini tekshirish imkoni bo‘lmadi." /></div>;
  if (!access.data?.isAdmin) return <div className="gate"><div className="gate-card"><div className="gate-mark"><ShieldCheck size={24} /></div><div className="eyebrow">KIRISH CHEKLANGAN</div><h1>Bu boshqaruv paneli<br />administratorlar uchun.</h1><p>Telegram guruhining admini hisobidan foydalaning yoki guruh administratoridan sizga ruxsat berishini so‘rang.</p><Link href="/" className="button button-outline">Bosh sahifaga qaytish <ArrowRight size={15} /></Link></div></div>;
  if (!access.data.isTelegramLinked || !access.data.groupSetupCompleted) return <Onboarding />;
  return <>{children}</>;
}
function Onboarding() {
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null); const [copied, setCopied] = useState(false);
  const mutation = useCreateTelegramAdminLinkCode({ mutation: { onSuccess: (result) => { setCode(result); queryClient.invalidateQueries({ queryKey: getGetQuizBotAccessQueryKey() }); } } });
  const steps = [
    ['01', 'Botni guruhga qo‘shing', 'Telegram guruhingizga botni a’zo qiling va unga xabar yuborish huquqini bering.'],
    ['02', 'Guruhda /setup yuboring', 'Telegram guruh admini /setup buyrug‘ini yuborib, boshlang‘ich sozlashni yakunlaydi.'],
    ['03', 'Bog‘lash kodini yarating', 'Quyidagi tugma qisqa muddat amal qiladigan maxsus kod yaratadi.'],
    ['04', 'Guruhga /link CODE yuboring', 'Yaratilgan kodni buyruq bilan guruhga yuboring. Bog‘lanish avtomatik tasdiqlanadi.'],
  ];
  const copyCode = async () => { if (code) { await navigator.clipboard.writeText(code.code); setCopied(true); window.setTimeout(() => setCopied(false), 1800); } };
  return <div className="onboarding-wrap page-enter"><div className="onboarding-intro"><div className="eyebrow">BIR MARTALIK SOZLASH</div><h1>Guruhingizni<br /><em>bog‘laymiz.</em></h1><p>Testlarni boshqarishdan oldin Telegram botni o‘quv guruhingiz bilan xavfsiz bog‘lang.</p><div className="onboarding-lock"><ShieldCheck size={18} /><span>Hozircha boshqaruv paneli yopiq<br /><small>Bog‘langandan keyin barcha bo‘limlar ochiladi</small></span></div></div><Card className="onboarding-card"><div className="card-heading"><div><h2>To‘rt qadam. Bir marta.</h2><p>Taxminan 2 daqiqa vaqt oladi.</p></div><div className="bot-seal"><Bot size={20} /></div></div><div className="setup-steps">{steps.map(([n, title, text], i) => <div className="setup-step" key={n}><span className={`step-number ${i < 2 ? 'step-done' : ''}`}>{i < 2 ? <Check size={13} /> : n}</span><div><b>{title}</b><p>{text}</p></div></div>)}</div><div className="code-area">{code ? <><div className="code-result-label"><CheckCircle2 size={16} /> Kod tayyor · {fmtTime(code.expiresAt)} gacha amal qiladi</div><div className="code-display"><span className="mono">{code.code}</span><Button variant="outline" onClick={copyCode}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'Nusxalandi' : 'Nusxa olish'}</Button></div><p className="code-instruction">Telegram guruhiga yuboring: <code>/link {code.code}</code></p></> : <Button onClick={() => mutation.mutate()} disabled={mutation.isPending} className="full-button">{mutation.isPending ? <LoaderCircle className="spin" size={16} /> : <Link2 size={16} />} {mutation.isPending ? 'Kod tayyorlanmoqda…' : 'Bog‘lash kodini yaratish'} <ArrowRight size={15} /></Button>}{mutation.isError && <p className="inline-error" role="alert">Kod yaratilmadi. Qayta urinib ko‘ring.</p>}</div><button className="refresh-access" onClick={() => queryClient.invalidateQueries({ queryKey: getGetQuizBotAccessQueryKey() })}><RefreshCw size={13} /> Bog‘lash holatini yangilash</button></Card></div>;
}

function Dashboard() {
  const q = useGetQuizBotDashboard({ query: { queryKey: getGetQuizBotDashboardQueryKey() } });
  if (q.isLoading) return <Loading />; if (q.isError || !q.data) return <ErrorState onRetry={() => q.refetch()} />;
  const d = q.data; const sessions = d.recentSessions ?? [];
  return <div className="page-enter"><PageTitle eyebrow="BUGUNGI HOLAT" title="O‘quv ritmi" description="Guruhingizdagi grammatik mashg‘ulotlar va so‘nggi faollik." action={<Link href="/topics" className="button button-primary"><Plus size={16} /> Mavzu qo‘shish</Link>} />
    <div className="metric-grid"><Metric label="Jami testlar" value={d.totalSessions} foot={`${d.quizzesThisWeek} tasi shu hafta`} icon={FileText} /><Metric label="Ishtirokchilar" value={d.totalParticipants} foot="Guruhdagi faol o‘quvchilar" icon={Users} tone="sage" /><Metric label="O‘rtacha natija" value={`${Math.round(d.averageScorePercent)}%`} foot="Barcha yakunlangan testlar" icon={Trophy} tone="navy" /></div>
    <div className="dashboard-grid"><Card className="next-quiz"><div className="section-kicker"><span className="kicker-dot" /> KEYINGI TEST</div>{d.nextQuizAt ? <><div className="next-date"><span className="next-day">{new Intl.DateTimeFormat('uz-UZ', { day: '2-digit' }).format(new Date(d.nextQuizAt))}</span><span><b>{fmtDate(d.nextQuizAt, { month: 'long', weekday: 'long' })}</b><small>{fmtTime(d.nextQuizAt)} · Toshkent vaqti</small></span></div><h2>{d.nextTopicTitle ?? 'Mavzu rejalashtirilmagan'}</h2><Link href="/topics" className="arrow-link">Jadvalni ko‘rish <ArrowRight size={15} /></Link></> : <div className="next-empty"><h2>Keyingi test belgilanmagan</h2><p>O‘quv ritmini davom ettirish uchun yangi mavzu rejalashtiring.</p><Link href="/topics" className="button button-outline"><Plus size={15} /> Mavzu rejalashtirish</Link></div>}<div className="next-decoration">§</div></Card>
      <Card className="activity-card"><div className="section-head"><div><div className="eyebrow">OXIRGI FAOLLIK</div><h2>So‘nggi testlar</h2></div><Link href="/history" className="small-link">Barchasi <ArrowRight size={14} /></Link></div>{sessions.length ? <div className="activity-list">{sessions.slice(0, 5).map((s, i) => <Link className="activity-row" href="/history" key={s.id} data-testid={`row-dashboard-session-${s.id}`}><span className={`activity-index index-${i % 3}`}>{String(i + 1).padStart(2, '0')}</span><span className="activity-main"><b>{s.topicTitle}</b><small>{fmtDate(s.scheduledDate)} · {s.participantCount} ishtirokchi</small></span><span className="activity-score">{Math.round(s.averageScorePercent)}%</span><Badge tone={s.status === 'completed' ? 'sage' : 'gold'}>{statusText[s.status] ?? s.status}</Badge></Link>)}</div> : <EmptyState title="Hali testlar yo‘q" body="Birinchi grammatik mavzuni rejalashtiring va o‘quv jarayonini boshlang." action={<Link href="/topics" className="small-link">Mavzu qo‘shish <ArrowRight size={14} /></Link>} />}</Card></div>
    <div className="dashboard-note"><Sparkles size={16} /><span><b>Barqarorlik — eng yaxshi strategiya.</b> Kichik, muntazam mashqlar katta natijaga olib keladi.</span><span className="note-book">Grammatik Aktiv · A2–B1</span></div>
  </div>;
}

function TopicEditor({ topic, onClose }: { topic?: QuizTopic; onClose: () => void }) {
  const qc = useQueryClient(); const create = useCreateQuizTopic(); const update = useUpdateQuizTopic();
  const [form, setForm] = useState({ title: topic?.title ?? '', bookUnit: topic?.bookUnit ?? '', bookPages: topic?.bookPages ?? '', notes: topic?.notes ?? '', scheduledFor: topic?.scheduledFor ? new Date(topic.scheduledFor).toISOString().slice(0, 16) : '' });
  const pending = create.isPending || update.isPending;
  const submit = (e: FormEvent) => { e.preventDefault(); const payload: QuizTopicInput | QuizTopicUpdate = { title: form.title.trim(), bookUnit: form.bookUnit || null, bookPages: form.bookPages || null, notes: form.notes || null, scheduledFor: new Date(form.scheduledFor).toISOString() };
    const ok = () => { qc.invalidateQueries({ queryKey: getListQuizTopicsQueryKey() }); qc.invalidateQueries({ queryKey: getGetQuizBotDashboardQueryKey() }); onClose(); };
    if (topic) update.mutate({ topicId: topic.id, data: payload }, { onSuccess: ok }); else create.mutate({ data: payload as QuizTopicInput }, { onSuccess: ok });
  };
  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><form className="modal-card" onSubmit={submit}><div className="modal-heading"><div><div className="eyebrow">{topic ? 'MAVZUNI TAHRIRLASH' : 'YANGI MAVZU'}</div><h2>{topic ? 'Mavzu ma’lumotlari' : 'Rejaga mavzu qo‘shish'}</h2></div><button type="button" className="icon-button" aria-label="Yopish" onClick={onClose}><X size={18} /></button></div><label className="field-label">Grammatika mavzusi<input required minLength={2} autoFocus placeholder="Masalan: Wechselpräpositionen" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></label><div className="field-pair"><label className="field-label">Dars / birlik<input placeholder="Lektion 12" value={form.bookUnit} onChange={e => setForm({ ...form, bookUnit: e.target.value })} /></label><label className="field-label">Sahifalar<input placeholder="S. 84–86" value={form.bookPages} onChange={e => setForm({ ...form, bookPages: e.target.value })} /></label></div><label className="field-label">Test vaqti<input required type="datetime-local" value={form.scheduledFor} onChange={e => setForm({ ...form, scheduledFor: e.target.value })} /></label><label className="field-label">Izoh<textarea rows={3} placeholder="Mavzu bo‘yicha qo‘shimcha qayd…" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></label><div className="modal-actions"><Button type="button" variant="quiet" onClick={onClose}>Bekor qilish</Button><Button type="submit" disabled={pending || !form.scheduledFor}>{pending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{pending ? 'Saqlanmoqda…' : topic ? 'O‘zgarishlarni saqlash' : 'Mavzu qo‘shish'}</Button></div>{(create.isError || update.isError) && <p className="inline-error">Saqlashda xatolik. Maydonlarni tekshirib qayta urinib ko‘ring.</p>}</form></div>;
}
function Topics() {
  const q = useListQuizTopics({ query: { queryKey: getListQuizTopicsQueryKey() } }); const remove = useDeleteQuizTopic(); const change = useUpdateQuizTopic(); const [editing, setEditing] = useState<QuizTopic | null | 'new'>(null); const qc = useQueryClient();
  const settings = useGetQuizBotSettings({ query: { queryKey: getGetQuizBotSettingsQueryKey() } });
  const del = (t: QuizTopic) => { if (window.confirm(`“${t.title}” mavzusini o‘chirishni xohlaysizmi?`)) remove.mutate({ topicId: t.id }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getListQuizTopicsQueryKey() }); qc.invalidateQueries({ queryKey: getGetQuizBotDashboardQueryKey() }); } }); };
  const flipStatus = (t: QuizTopic) => change.mutate({ topicId: t.id, data: { status: t.status === 'planned' ? 'used' : 'planned' } }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getListQuizTopicsQueryKey() }); qc.invalidateQueries({ queryKey: getGetQuizBotDashboardQueryKey() }); } });
  return <div className="page-enter"><PageTitle eyebrow="O‘QUV DASTURI" title="Mavzular jadvali" description="Grammatik Aktiv bo‘yicha kelgusi test mavzularini rejalashtiring." action={<Button onClick={() => setEditing('new')}><Plus size={16} /> Mavzu qo‘shish</Button>} />{q.isLoading ? <Loading /> : q.isError ? <ErrorState onRetry={() => q.refetch()} /> : !q.data?.length ? <Card><EmptyState icon={BookOpen} title="Jadval hozircha bo‘sh" body="Birinchi grammatik mavzuni qo‘shib, guruhingiz uchun test rejalashtiring." action={<Button onClick={() => setEditing('new')}><Plus size={15} /> Mavzu qo‘shish</Button>} /></Card> : <Card className="table-card"><div className="table-toolbar"><div><h2>Rejalashtirilgan mavzular</h2><p>{q.data.length} ta mavzu <span>·</span> sana bo‘yicha tartiblangan</p></div><Badge tone="gold">{q.data.filter(t => t.status === 'planned').length} kutilmoqda</Badge></div><div className="table-scroll"><table><thead><tr><th>MAVZU</th><th>GRAMMATIK AKTIV</th><th>TEST VAQTI</th><th>HOLAT</th><th /></tr></thead><tbody>{q.data.map(t => <tr key={t.id} data-testid={`row-topic-${t.id}`}><td><span className="table-primary">{t.title}</span><small className="table-secondary">{t.notes || '—'}</small></td><td><span>{t.bookUnit || '—'}</span><small className="table-secondary">{t.bookPages || 'Sahifa kiritilmagan'}</small></td><td><span>{fmtDate(t.scheduledFor)}</span><small className="table-secondary">{fmtTimeInZone(t.scheduledAt, settings.data?.timezone ?? 'Asia/Tashkent')}</small></td><td><Badge tone={t.status === 'used' ? 'sage' : 'gold'}>{statusText[t.status] ?? t.status}</Badge></td><td><div className="row-actions"><button className="icon-button" aria-label={t.status === 'planned' ? 'Mavzuni ishlatilgan deb belgilash' : 'Mavzuni rejaga qaytarish'} disabled={change.isPending || !['planned', 'used'].includes(t.status)} onClick={() => flipStatus(t)}><Check size={15} /></button><button className="icon-button" aria-label="Mavzuni tahrirlash" onClick={() => setEditing(t)}><Pencil size={15} /></button><button className="icon-button danger-icon" aria-label="Mavzuni o‘chirish" disabled={remove.isPending} onClick={() => del(t)}><Trash2 size={15} /></button></div></td></tr>)}</tbody></table></div></Card>}{(remove.isError || change.isError) && <p className="inline-error">Mavzuni yangilashda xatolik yuz berdi.</p>}{editing && <TopicEditor topic={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}</div>;
}

function SessionDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useGetQuizSession(id, { query: { queryKey: getGetQuizSessionQueryKey(id) } }); const [expanded, setExpanded] = useState<string | null>(null);
  return <div className="modal-backdrop detail-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}><section className="detail-drawer"><div className="drawer-top"><div><div className="eyebrow">TEST TAFSILOTI</div><h2>{q.data?.session.topicTitle ?? 'Test sessiyasi'}</h2></div><button className="icon-button" aria-label="Yopish" onClick={onClose}><X size={18} /></button></div>{q.isLoading ? <Loading /> : q.isError || !q.data ? <ErrorState onRetry={() => q.refetch()} /> : <><div className="drawer-meta"><Badge tone={q.data.session.status === 'completed' ? 'sage' : 'gold'}>{statusText[q.data.session.status]}</Badge><span>{fmtDate(q.data.session.scheduledDate)} · {q.data.session.participantCount} o‘quvchi</span><span>{q.data.session.questionCount} savol</span></div><h3 className="subsection-title">Ishtirokchilar natijasi</h3><div className="participant-results">{q.data.participants.map((p, i) => <div className="participant-result" key={p.telegramUserId}><span className="rank-chip">{String(i + 1).padStart(2, '0')}</span><b>{p.displayName}</b><span className="result-count">{p.correctAnswers}/{p.correctAnswers + p.incorrectAnswers + p.unanswered} to‘g‘ri</span><strong>{Math.round(p.scorePercent)}%</strong></div>)}</div><h3 className="subsection-title question-title">Savollar va javoblar</h3><div className="question-stack">{q.data.questions.map(question => <div className="question-card" key={question.id}><button className="question-toggle" onClick={() => setExpanded(expanded === question.id ? null : question.id)}><span className="question-no">{String(question.position).padStart(2, '0')}</span><span>{question.prompt}</span>{expanded === question.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button>{expanded === question.id && <div className="question-content"><div className="answer-options">{question.options.map((op, idx) => <div className={`answer-option ${idx === question.correctOptionIndex ? 'answer-correct' : ''}`} key={op}><span>{String.fromCharCode(65 + idx)}</span>{op}{idx === question.correctOptionIndex && <Check size={14} />}</div>)}</div><p className="explanation">{question.explanation}</p><div className="answers-table">{question.answers.map(a => <div key={a.telegramUserId}><span>{a.displayName}</span><span>{a.selectedOptionIndex === null ? 'Javob berilmadi' : question.options[a.selectedOptionIndex]}</span><Badge tone={a.isCorrect === true ? 'sage' : a.isCorrect === false ? 'red' : 'neutral'}>{a.isCorrect === true ? 'To‘g‘ri' : a.isCorrect === false ? 'Noto‘g‘ri' : 'Javobsiz'}</Badge></div>)}</div></div>}</div>)}</div></>}</section></div>;
}
function History() {
  const q = useListQuizSessions({ limit: 100 }, { query: { queryKey: getListQuizSessionsQueryKey({ limit: 100 }) } }); const [selected, setSelected] = useState<string | null>(null);
  return <div className="page-enter"><PageTitle eyebrow="NATIJALAR ARXIVI" title="Testlar tarixi" description="Har bir sessiya, savol va ishtirokchi javoblari bo‘yicha batafsil ko‘rinish." />{q.isLoading ? <Loading /> : q.isError ? <ErrorState onRetry={() => q.refetch()} /> : !q.data?.length ? <Card><EmptyState icon={Activity} title="Tarix hali shakllanmadi" body="Test yakunlangach, sessiya natijalari shu yerda paydo bo‘ladi." /></Card> : <Card className="table-card"><div className="table-toolbar"><div><h2>Barcha sessiyalar</h2><p>So‘nggi {q.data.length} ta test</p></div><Badge tone="neutral">{q.data.length} sessiya</Badge></div><div className="table-scroll"><table><thead><tr><th>MAVZU</th><th>SANA</th><th>ISHTIROKCHI</th><th>SAVOL</th><th>O‘RTACHA NATIJA</th><th>HOLAT</th><th /></tr></thead><tbody>{q.data.map(s => <tr key={s.id} data-testid={`row-session-${s.id}`}><td><button className="table-primary table-link" onClick={() => setSelected(s.id)}>{s.topicTitle}</button></td><td>{fmtDate(s.scheduledDate)}</td><td><span className="mono">{s.participantCount.toString().padStart(2, '0')}</span></td><td><span className="mono">{s.questionCount.toString().padStart(2, '0')}</span></td><td><span className="score-cell">{Math.round(s.averageScorePercent)}%</span><span className="mini-track"><i style={{ width: `${Math.max(0, Math.min(s.averageScorePercent, 100))}%` }} /></span></td><td><Badge tone={s.status === 'completed' ? 'sage' : s.status === 'cancelled' ? 'red' : 'gold'}>{statusText[s.status]}</Badge></td><td><button className="icon-button" aria-label={`${s.topicTitle} tafsilotlari`} onClick={() => setSelected(s.id)}><ArrowRight size={15} /></button></td></tr>)}</tbody></table></div></Card>}{selected && <SessionDetailModal id={selected} onClose={() => setSelected(null)} />}</div>;
}
function Participants() {
  const participants = useListQuizParticipants({ query: { queryKey: getListQuizParticipantsQueryKey() } }); const leaderboard = useGetQuizLeaderboard({ query: { queryKey: getGetQuizLeaderboardQueryKey() } }); const [personId, setPersonId] = useState<string | null>(null);
  const items = leaderboard.data?.length ? leaderboard.data : participants.data;
  return <div className="page-enter"><PageTitle eyebrow="GURUH NATIJALARI" title="Ishtirokchilar" description="Har bir o‘quvchining qatnashuvi, o‘rtacha natijasi va o‘sish sur’ati." /><div className="participant-summary"><Card className="rank-intro"><div className="rank-emblem"><Trophy size={21} /></div><div><div className="eyebrow">GURUH REYTINGI</div><h2>O‘sishni kuzating.</h2><p>Natijalar testlar bo‘yicha yangilanadi. Ismni tanlab, batafsil tarixni oching.</p></div><div className="rank-decoration">§</div></Card><div className="participant-stat"><span>ISHTIROKCHILAR</span><b>{participants.data?.length ?? '—'}<small> / 10</small></b><i><Users size={15} /> Kichik guruh, yaqin natija</i></div></div>{participants.isLoading || leaderboard.isLoading ? <Loading /> : participants.isError || leaderboard.isError ? <ErrorState onRetry={() => { participants.refetch(); leaderboard.refetch(); }} /> : !items?.length ? <Card><EmptyState icon={Users} title="Ishtirokchilar hali yo‘q" body="Guruh a’zolari birinchi testda qatnashgach, natijalari shu yerda ko‘rinadi." /></Card> : <Card className="table-card"><div className="table-toolbar"><div><h2>O‘quvchilar reytingi</h2><p>O‘rtacha natija bo‘yicha tartiblangan</p></div><div className="legend"><span className="legend-dot" /> Faol o‘quvchilar</div></div><div className="table-scroll"><table><thead><tr><th>O‘RIN</th><th>ISHTIROKCHI</th><th>TESTLAR</th><th>TO‘G‘RI JAVOB</th><th>O‘RTACHA NATIJA</th><th>OXIRGI FAOLLIK</th><th /></tr></thead><tbody>{items.map((p, i) => { const rank = 'rank' in p ? p.rank : i + 1; return <tr key={p.telegramUserId} data-testid={`row-participant-${p.telegramUserId}`}><td><span className={`leader-rank ${rank === 1 ? 'first-place' : ''}`}>{String(rank).padStart(2, '0')}</span></td><td><button className="person-name" onClick={() => setPersonId(p.telegramUserId)}><span className={`person-avatar avatar-${i % 4}`}>{p.displayName.split(' ').map(s => s[0]).join('').slice(0, 2).toUpperCase()}</span><span>{p.displayName}<small>{p.username ? `@${p.username}` : 'Telegram a’zosi'}</small></span></button></td><td><span className="mono">{p.quizzesPlayed}</span></td><td>{p.correctAnswers}<span className="table-secondary inline-muted"> ta</span></td><td><div className="progress-score"><span>{Math.round(p.averageScorePercent)}%</span><span className="mini-track"><i style={{ width: `${Math.max(0, Math.min(p.averageScorePercent, 100))}%` }} /></span></div></td><td>{fmtDate(p.lastSeenAt)}</td><td><button className="icon-button" aria-label={`${p.displayName} tarixini ko‘rish`} onClick={() => setPersonId(p.telegramUserId)}><ArrowRight size={15} /></button></td></tr>})}</tbody></table></div></Card>}{personId && <ParticipantModal id={personId} onClose={() => setPersonId(null)} />}</div>;
}
function ParticipantModal({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useGetQuizParticipant(id, { query: { queryKey: getGetQuizParticipantQueryKey(id) } });
  return <div className="modal-backdrop detail-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}><section className="detail-drawer participant-drawer"><div className="drawer-top"><div><div className="eyebrow">ISHTIROKCHI PROFILI</div><h2>{q.data?.participant.displayName ?? 'O‘quvchi'}</h2></div><button className="icon-button" aria-label="Yopish" onClick={onClose}><X size={18} /></button></div>{q.isLoading ? <Loading /> : q.isError || !q.data ? <ErrorState onRetry={() => q.refetch()} /> : <><div className="profile-stats"><div><span>O‘RTACHA</span><b>{Math.round(q.data.participant.averageScorePercent)}%</b></div><div><span>TESTLAR</span><b>{q.data.participant.quizzesPlayed}</b></div><div><span>TO‘G‘RI JAVOB</span><b>{q.data.participant.correctAnswers}</b></div></div><h3 className="subsection-title">Testlar bo‘yicha tarix</h3>{q.data.history.length ? <div className="history-stack">{q.data.history.map((h, i) => <div className="history-entry" key={h.sessionId}><span className={`history-mark ${h.scorePercent >= 70 ? 'mark-good' : 'mark-mid'}`}>{String(i + 1).padStart(2, '0')}</span><span><b>{h.topicTitle}</b><small>{fmtDate(h.scheduledDate)} · {h.correctAnswers} to‘g‘ri · {h.incorrectAnswers} xato</small></span><strong>{Math.round(h.scorePercent)}%</strong></div>)}</div> : <EmptyState title="Test tarixi yo‘q" body="Bu ishtirokchi hali testda qatnashmagan." />}</>}</section></div>;
}

function Settings() {
  const qc = useQueryClient();
  const q = useGetQuizBotSettings({
    query: { queryKey: getGetQuizBotSettingsQueryKey() },
  });
  const bot = useGetTelegramBotStatus({
    query: { queryKey: getGetTelegramBotStatusQueryKey() },
  });
  const save = useUpdateQuizBotSettings({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetQuizBotSettingsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetQuizBotDashboardQueryKey() });
      },
    },
  });
  const test = useTestTelegramBotConnection({
    mutation: {
      onSuccess: () =>
        qc.invalidateQueries({ queryKey: getGetTelegramBotStatusQueryKey() }),
    },
  });
  const [form, setForm] = useState<Partial<BotSettings>>({});
  useEffect(() => {
    if (q.data) setForm(q.data);
  }, [q.data]);
  const set = <K extends keyof BotSettings>(key: K, value: BotSettings[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const questionCountOptions = [5, 10, 15, 20, 30] as const;
  const secondsPerQuestionOptions = [15, 20, 25, 30] as const;
  const selectedQuestionCount =
    questionCountOptions.find(
      (value) => value === Number(form.questionCount),
    ) ?? 10;
  const selectedSecondsPerQuestion =
    secondsPerQuestionOptions.find(
      (value) => value === Number(form.secondsPerQuestion),
    ) ?? 30;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.dailyTime || !form.timezone || !form.bookTitle) return;
    save.mutate({
      data: {
        groupChatId: form.groupChatId ?? null,
        dailyTime: form.dailyTime,
        timezone: form.timezone,
        minimumParticipants: Number(form.minimumParticipants),
        signupWindowMinutes: Number(form.signupWindowMinutes),
        questionCount: selectedQuestionCount,
        secondsPerQuestion: selectedSecondsPerQuestion,
        enabled: Boolean(form.enabled),
        bookTitle: form.bookTitle,
      },
    });
  };
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorState onRetry={() => q.refetch()} />;
  return (
    <div className="page-enter">
      <PageTitle
        eyebrow="BOT VA GURUH"
        title="Sozlamalar"
        description="Test jadvali, qatnashuv talablari va Telegram ulanishini boshqaring."
      />
      <div className="settings-layout">
        <div className="settings-main">
          <form onSubmit={submit}>
            <Card className="settings-card">
              <div className="settings-card-head">
                <div className="settings-icon">
                  <Clock3 size={18} />
                </div>
                <div>
                  <h2>Kunlik test jadvali</h2>
                  <p>Guruh uchun avtomatik test vaqtini belgilang.</p>
                </div>
                <label className="switch-wrap">
                  <input
                    type="checkbox"
                    checked={Boolean(form.enabled)}
                    onChange={(e) => set("enabled", e.target.checked)}
                  />
                  <span className="switch" />
                  <span className="sr-only">Botni faollashtirish</span>
                </label>
              </div>
              <div className="settings-fields">
                <label className="field-label">
                  Har kungi vaqt
                  <input
                    type="time"
                    value={form.dailyTime ?? ""}
                    onChange={(e) => set("dailyTime", e.target.value)}
                  />
                </label>
                <label className="field-label">
                  Vaqt mintaqasi
                  <select
                    value={form.timezone ?? "Asia/Tashkent"}
                    onChange={(e) => set("timezone", e.target.value)}
                  >
                    <option value="Asia/Tashkent">Asia/Tashkent (UTC+5)</option>
                    <option value="Europe/Berlin">Europe/Berlin</option>
                    <option value="UTC">UTC</option>
                  </select>
                </label>
              </div>
              <div className="settings-inline-note">
                <Clock3 size={15} />
                <span>
                  Ro‘yxatdan o‘tish oynasi test boshlanishidan oldin ochiladi.
                </span>
              </div>
              <div className="settings-fields settings-fields-three">
                <label className="field-label">
                  Minimal qatnashuvchi
                  <input
                    type="number"
                    min="3"
                    max="10"
                    value={form.minimumParticipants ?? 3}
                    onChange={(e) =>
                      set("minimumParticipants", Number(e.target.value))
                    }
                  />
                  <small>3–10 kishi</small>
                </label>
                <label className="field-label">
                  Ro‘yxat oynasi
                  <input
                    type="number"
                    min="1"
                    max="120"
                    value={form.signupWindowMinutes ?? 10}
                    onChange={(e) =>
                      set("signupWindowMinutes", Number(e.target.value))
                    }
                  />
                  <small>daqiqada</small>
                </label>
                <label className="field-label">
                  Savollar soni
                  <select
                    value={selectedQuestionCount}
                    onChange={(e) =>
                      set("questionCount", Number(e.target.value))
                    }
                  >
                    {questionCountOptions.map((count) => (
                      <option key={count} value={count}>
                        {count} ta
                      </option>
                    ))}
                  </select>
                  <small>5, 10, 15, 20 yoki 30 ta savol</small>
                </label>
              </div>
              <div className="settings-fields">
                <label className="field-label">
                  Har bir savolga vaqt
                  <select
                    value={selectedSecondsPerQuestion}
                    onChange={(e) =>
                      set("secondsPerQuestion", Number(e.target.value))
                    }
                  >
                    {secondsPerQuestionOptions.map((seconds) => (
                      <option key={seconds} value={seconds}>
                        {seconds} soniya
                      </option>
                    ))}
                  </select>
                  <small>har bir savol uchun</small>
                </label>
                <label className="field-label">
                  Asosiy darslik
                  <input
                    value={form.bookTitle ?? ""}
                    onChange={(e) => set("bookTitle", e.target.value)}
                    placeholder="Grammatik Aktiv"
                  />
                </label>
              </div>
              <div className="form-footer">
                <span>
                  {save.isSuccess ? (
                    <>
                      <CheckCircle2 size={14} /> O‘zgarishlar saqlandi
                    </>
                  ) : (
                    "Barcha vaqtlar tanlangan mintaqada ko‘rsatiladi."
                  )}
                </span>
                <Button type="submit" disabled={save.isPending}>
                  {save.isPending ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <Check size={15} />
                  )}
                  {save.isPending ? "Saqlanmoqda…" : "Sozlamalarni saqlash"}
                </Button>
              </div>
              {save.isError && (
                <p className="inline-error">
                  Saqlab bo‘lmadi. Ma’lumotlarni tekshiring va qayta urinib
                  ko‘ring.
                </p>
              )}
            </Card>
          </form>
          <Card className="settings-card group-card">
            <div className="settings-card-head">
              <div className="settings-icon">
                <MessageCircle size={18} />
              </div>
              <div>
                <h2>Telegram guruhi</h2>
                <p>Bot ulangan guruhni tekshiring va ulanishni sinang.</p>
              </div>
            </div>
            <div className="group-info">
              <label className="field-label">
                GURUH ID
                <input
                  value={form.groupChatId ?? ""}
                  placeholder="Telegram group chat ID"
                  onChange={(e) => set("groupChatId", e.target.value || null)}
                />
              </label>
              <div>
                <span className="field-label-text">ULANGAN ADMINLAR</span>
                <b>{q.data.linkedAdminCount}</b>
              </div>
            </div>
            <div className="group-actions">
              <Button
                variant="outline"
                onClick={() => test.mutate()}
                disabled={test.isPending}
              >
                {test.isPending ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <Zap size={15} />
                )}
                {test.isPending ? "Tekshirilmoqda…" : "Ulanishni sinash"}
              </Button>
              <span className="group-message">
                {test.data?.message ??
                  (bot.data?.telegramConnected
                    ? `${bot.data.botUsername ? "@" + bot.data.botUsername : "Telegram bot"} faol`
                    : "Ulanish holatini tekshiring")}
              </span>
            </div>
            {test.isError && (
              <p className="inline-error">Ulanish sinovi bajarilmadi.</p>
            )}
          </Card>
        </div>
        <aside className="settings-aside">
          <Card className="health-card">
            <div className="health-header">
              <span className="health-icon">
                <Bot size={18} />
              </span>
              <div>
                <h3>Bot holati</h3>
                <small>So‘nggi ulanish tekshiruvi</small>
              </div>
              <button
                className="icon-button"
                aria-label="Bot holatini yangilash"
                onClick={() => bot.refetch()}
              >
                <RefreshCw size={14} />
              </button>
            </div>
            {bot.isLoading ? (
              <div className="health-loading">
                <span className="skeleton skeleton-line" />
              </div>
            ) : bot.isError ? (
              <div className="health-error">Holatni olish imkoni bo‘lmadi</div>
            ) : (
              <div className="health-list">
                <HealthLine
                  label="Telegram token"
                  ok={bot.data?.telegramTokenConfigured}
                />
                <HealthLine
                  label="Telegram API"
                  ok={bot.data?.telegramConnected}
                />
                <HealthLine
                  label="Guruhga ulanish"
                  ok={bot.data?.groupConnected}
                />
                <HealthLine
                  label="AI xizmati"
                  ok={bot.data?.openRouterKeyConfigured}
                />
                <HealthLine label="Test rejimi" ok={bot.data?.polling} />
              </div>
            )}
            {bot.data?.lastError && (
              <p className="health-error">{bot.data.lastError}</p>
            )}
            <div className="model-line">
              <span>AI modeli</span>
              <code>{bot.data?.aiModel ?? q.data.aiModel}</code>
            </div>
          </Card>
          <Card className="settings-book">
            <div className="book-symbol">§</div>
            <div className="eyebrow">O‘QUV MANBAI</div>
            <h3>{q.data.bookTitle}</h3>
            <p>Har kungi testlar shu darslikdagi mavzular asosida tuziladi.</p>
            <span className="mono">A2 — B1</span>
          </Card>
          <div className="settings-help">
            <CircleHelp size={16} />
            <span>
              Ulanishda muammo bormi?
              <small>Telegram guruhida /setup buyrug‘ini tekshiring.</small>
            </span>
          </div>
        </aside>
      </div>
    </div>
  );
}
function HealthLine({ label, ok }: { label: string; ok?: boolean }) { return <div className="health-line"><span className="health-label">{label}</span><Badge tone={ok ? 'sage' : 'red'}><span className={`health-dot ${ok ? 'dot-ok' : 'dot-no'}`} />{ok ? 'Tayyor' : 'Tekshirish kerak'}</Badge></div>; }

function ProtectedPage({ active, children }: { active: string; children: ReactNode }) {
  return <><Show when="signed-in"><AccessGate><Layout active={active}>{children}</Layout></AccessGate></Show><Show when="signed-out"><Redirect to="/" /></Show></>;
}
function HomeRedirect() { return <><Show when="signed-in"><Redirect to="/dashboard" /></Show><Show when="signed-out"><PublicHome /></Show></>; }
function RoutedErrorBoundary({ children }: { children: ReactNode }) { const [location] = useLocation(); return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>; }
function Router() {
  return <RoutedErrorBoundary><Switch>
    <Route path="/" component={HomeRedirect} />
    <Route path="/sign-in/*?" component={() => <AuthPage />} />
    <Route path="/sign-up/*?" component={() => <AuthPage signup />} />
    <Route path="/dashboard">{() => <ProtectedPage active="/dashboard"><Dashboard /></ProtectedPage>}</Route>
    <Route path="/topics">{() => <ProtectedPage active="/topics"><Topics /></ProtectedPage>}</Route>
    <Route path="/history">{() => <ProtectedPage active="/history"><History /></ProtectedPage>}</Route>
    <Route path="/participants">{() => <ProtectedPage active="/participants"><Participants /></ProtectedPage>}</Route>
    <Route path="/settings">{() => <ProtectedPage active="/settings"><Settings /></ProtectedPage>}</Route>
    <Route component={() => <div className="not-found"><span className="mono">404</span><h1>Bu sahifa topilmadi.</h1><Link href="/" className="button button-outline">Bosh sahifaga qaytish</Link></div>} />
  </Switch></RoutedErrorBoundary>;
}
function ClerkRoutes() {
  const [, setLocation] = useLocation();
  return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={appearance} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} localization={{ signIn: { start: { title: 'Xush kelibsiz', subtitle: 'O‘quv boshqaruviga kiring' } }, signUp: { start: { title: 'Hisob yarating', subtitle: 'Guruh boshqaruvini boshlang' } } }} routerPush={(to: string) => setLocation(stripBase(to))} routerReplace={(to: string) => setLocation(stripBase(to), { replace: true })}>
    <QueryClientProvider client={queryClient}><ClerkCacheSync /><TooltipProvider><Router /><Toaster /></TooltipProvider></QueryClientProvider>
  </ClerkProvider>;
}
function App() {
  return <WouterRouter base={basePath}><ClerkRoutes /></WouterRouter>;
}
export default App;
