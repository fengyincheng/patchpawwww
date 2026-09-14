import { cloneElement, isValidElement, useCallback, useEffect, useId, useState } from 'react';
import type { FormEvent, ReactElement, ReactNode } from 'react';
import {
  adminApi,
  ApiError,
  type BindingKind,
  type Command,
  type CommandPayload,
  type ConversationProfile,
  type EffectiveConfiguration,
  type ExecutionType,
  type Model,
  type ModelPayload,
  type Permission,
  type PromptAsset,
  type PromptBinding,
  type PromptPayload,
  type Provider,
  type ProviderPayload,
  type PublicSetupInfo,
  type Repository,
  type SkillAsset,
  type SkillBinding,
  type SkillPayload,
  type Session,
} from './api.js';
import { I18nProvider, useI18n, type MessageKey } from './i18n.js';

type Section = 'repositories' | 'public-prompts' | 'public-skills' | 'models' | 'workflow' | 'settings';
type RepoTab = 'overview' | 'prompts' | 'skills' | 'commands' | 'conversation';
type Route = { section: Section; repo?: string; tab?: RepoTab };
type IconName = 'grid' | 'file' | 'spark' | 'cube' | 'workflow' | 'gear' | 'logout' | 'arrow' | 'plus' | 'save' | 'trash' | 'copy' | 'up' | 'down' | 'check' | 'warning' | 'lock' | 'refresh' | 'eye' | 'edit' | 'chevron';

function parseRoute(): Route {
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'repositories' && parts[1]) {
    let repo = parts[1];
    try { repo = decodeURIComponent(repo); } catch { /* malformed deep link is handled as a missing repository */ }
    const tab = parts[2] as RepoTab | undefined;
    return { section: 'repositories', repo, tab: tab && ['overview', 'prompts', 'skills', 'commands', 'conversation'].includes(tab) ? tab : 'overview' };
  }
  const section = parts[0] as Section | undefined;
  return { section: section && ['repositories', 'public-prompts', 'public-skills', 'models', 'workflow', 'settings'].includes(section) ? section : 'repositories' };
}

function useRoute() {
  const [route, setRoute] = useState<Route>(() => parseRoute());
  useEffect(() => {
    const onPopState = () => setRoute(parseRoute());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  const go = useCallback((href: string) => {
    window.history.pushState({}, '', href);
    setRoute(parseRoute());
    window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, []);
  return { route, go };
}

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, string> = {
    grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
    file: 'M6 3h8l4 4v14H6zM14 3v5h5M9 13h6M9 17h6',
    spark: 'M12 3l1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6zM19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z',
    cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
    workflow: 'M5 6h5v5H5zM14 15h5v5h-5zM15 6h4v4h-4zM10 8h5M17 10v5M10 8v8h4',
    gear: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm0-5 1 .2.7 2 1.6.7 1.8-.9 1.4 1.4-.9 1.8.7 1.6 2 .7.2 1v2l-2 .7-.7 1.6.9 1.8-1.4 1.4-1.8-.9-1.6.7-.7 2-1 .2h-2l-.7-2-1.6-.7-1.8.9-1.4-1.4.9-1.8-.7-1.6-2-.7v-2l2-.7.7-1.6-.9-1.8 1.4-1.4 1.8.9 1.6-.7.7-2z',
    logout: 'M14 5h6v14h-6M20 12H8m4-4-4 4 4 4M4 5v14',
    arrow: 'M5 12h14m-6-6 6 6-6 6',
    plus: 'M12 5v14M5 12h14',
    save: 'M5 4h12l2 2v14H5zM8 4v6h8V4M8 20v-6h8v6',
    trash: 'M5 7h14M10 11v6M14 11v6M8 7l1-3h6l1 3m-9 0 1 14h8l1-14',
    copy: 'M8 8h11v12H8zM5 16H4V4h12v1',
    up: 'M12 19V5m-5 5 5-5 5 5',
    down: 'M12 5v14m-5-5 5 5 5-5',
    check: 'M5 12l4 4L19 6',
    warning: 'M12 4l9 16H3zM12 9v5m0 3v.1',
    lock: 'M6 10h12v10H6zM8 10V7a4 4 0 0 1 8 0v3',
    refresh: 'M20 11a8 8 0 1 0 1 4M20 5v6h-6',
    eye: 'M3 12s3-6 9-6 9 6 9 6-3 6-9 6-9-6-9-6zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    edit: 'M4 20h4L19 9l-4-4L4 16zM13 6l4 4',
    chevron: 'M9 5l7 7-7 7',
  };
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

function Button({ children, variant = 'secondary', icon, type = 'button', disabled, onClick, className = '' }: { children: ReactNode; variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; icon?: IconName; type?: 'button' | 'submit'; disabled?: boolean; onClick?: () => void; className?: string }) {
  return <button type={type} className={`button button-${variant} ${className}`} disabled={disabled} onClick={onClick}>{icon && <Icon name={icon} size={16} />}<span>{children}</span></button>;
}

function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'accent' }) {
  return <span className={`badge badge-${tone}`}><span className="badge-dot" />{children}</span>;
}

function Field({ label, hint, error, children, required = false }: { label: string; hint?: string; error?: string; children: ReactNode; required?: boolean }) {
  const { t } = useI18n();
  const controlId = useId();
  const childIsLabel = isValidElement(children) && children.type === 'label';
  const labelledChildren = !childIsLabel && isValidElement(children)
    ? cloneElement(children as ReactElement<{ id?: string }>, { id: (children.props as { id?: string }).id ?? controlId })
    : children;
  return <div className="field"><label htmlFor={childIsLabel ? undefined : controlId}>{label}{required && <span className="required"> {t('required')}</span>}</label>{labelledChildren}{hint && <p className="field-hint">{hint}</p>}{Boolean(error) && <p className="field-error" role="alert">{error}</p>}</div>;
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`input ${props.className ?? ''}`} />;
}

function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`input select ${props.className ?? ''}`} />;
}

function Loading({ label = 'Loading configuration…' }: { label?: string }) {
  const { t } = useI18n();
  const resolvedLabel = label === 'Loading configuration…' ? t('loadingConfiguration') : label;
  return <div className="state-panel"><span className="spinner" aria-hidden="true" /><p>{resolvedLabel}</p></div>;
}

function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useI18n();
  const errorMessage = error instanceof ApiError ? error.message : error instanceof Error ? error.message : t('requestFailed');
  return <div className="state-panel state-error"><div className="state-icon"><Icon name="warning" /></div><div><h3>{t('couldNotLoadView')}</h3><p>{errorMessage}</p>{error instanceof ApiError && error.requestId && <p className="mono">{t('requestId', { id: error.requestId })}</p>}{onRetry && <Button variant="secondary" icon="refresh" onClick={onRetry}>{t('tryAgain')}</Button>}</div></div>;
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-mark">∅</div><h3>{title}</h3><p>{body}</p>{action}</div>;
}

function useUnsavedChangesGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
}

function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <div className="page-header"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p className="page-description">{description}</p>}</div>{actions && <div className="header-actions">{actions}</div>}</div>;
}

function SetupGuide({ setup, loading = false, error }: { setup?: PublicSetupInfo; loading?: boolean; error?: unknown }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState<string>();
  const [copyFailed, setCopyFailed] = useState(false);
  const browserOrigin = typeof window === 'undefined' ? undefined : window.location.origin;
  const originMismatch = Boolean(setup?.public_origin && browserOrigin && setup.public_origin !== browserOrigin);
  const copy = async (key: string, value: string | null) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setCopyFailed(false);
      window.setTimeout(() => setCopied(current => current === key ? undefined : current), 2200);
    } catch {
      setCopyFailed(true);
    }
  };
  const status = (configured: boolean | undefined) => <Badge tone={configured === undefined ? 'neutral' : configured ? 'success' : 'warning'}>{configured === undefined ? t('setupLoading') : configured ? t('configured') : t('notConfigured')}</Badge>;
  const displayOrigin = setup?.public_origin ?? t('notConfigured');
  const displayWebhook = setup?.webhook_url ?? t('notConfigured');
  return <section className="setup-guide panel" aria-labelledby="setup-guide-title"><div className="panel-heading"><div><p className="eyebrow">{t('firstRunSetup')}</p><h2 id="setup-guide-title">{t('setupGuideTitle')}</h2><p>{t('setupGuideDescription')}</p></div><Icon name="lock" /></div>{Boolean(error) && <div className="inline-alert setup-alert"><Icon name="warning" /><span>{t('setupUnavailable')}</span></div>}<div className="setup-body"><dl className="setup-facts"><div><dt>{t('publicOrigin')}</dt><dd><span className="mono setup-value">{displayOrigin}</span>{setup?.public_origin && <button className="button button-ghost" type="button" onClick={() => void copy('origin', setup.public_origin)}>{copied === 'origin' ? t('copied') : t('copy')}</button>}</dd></div><div><dt>{t('githubWebhookUrl')}</dt><dd><span className="mono setup-value">{displayWebhook}</span>{setup?.webhook_url && <button className="button button-ghost" type="button" onClick={() => void copy('webhook', setup.webhook_url)}>{copied === 'webhook' ? t('copied') : t('copy')}</button>}</dd></div><div><dt>{t('httpsStatus')}</dt><dd>{status(setup?.https_enabled)}{setup && !setup.https_enabled && <span className="setup-note">{t('httpsRequiredForProduction')}</span>}</dd></div><div><dt>{t('adminTokenStatus')}</dt><dd>{status(setup?.admin_auth_configured)}</dd></div><div><dt>{t('browserOriginStatus')}</dt><dd>{setup ? originMismatch ? <Badge tone="danger">{t('originMismatch')}</Badge> : <Badge tone="success">{t('originMatches')}</Badge> : status(undefined)}</dd></div></dl>{copyFailed && <p className="field-error setup-copy-error" role="alert">{t('copyFailed')}</p>}<p className="setup-instructions">{t('setupGuideInstructions')}</p>{loading && <p className="setup-loading"><span className="spinner" aria-hidden="true" />{t('loadingSetup')}</p>}</div></section>;
}

function Login({ onLogin, setup, setupLoading, setupError }: { onLogin: (token: string) => Promise<void>; setup?: PublicSetupInfo; setupLoading: boolean; setupError?: unknown }) {
  const { t } = useI18n();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(undefined);
    try { await onLogin(token); } catch (err) { setError(err instanceof Error ? err.message : t('invalidAdminCredentials')); } finally { setBusy(false); }
  };
  return <main className="auth-screen"><div className="auth-panel"><div className="brand-lockup"><span className="brand-mark">P</span><span>PatchPaw</span></div><p className="eyebrow">{t('controlPlaneLogin')}</p><h1>{t('loginTitle')}</h1><p className="auth-copy">{t('loginCopy')}</p><SetupGuide setup={setup} loading={setupLoading} error={setupError} /><form onSubmit={submit}><Field label={t('operatorToken')} hint={t('tokenHint')} error={error} required><TextInput type="password" autoComplete="current-password" value={token} onChange={event => setToken(event.target.value)} autoFocus required /></Field><Button type="submit" variant="primary" disabled={busy || !token} icon="arrow">{busy ? t('signingIn') : t('signIn')}</Button></form><p className="auth-footnote"><Icon name="lock" size={14} /> {t('protectedBySession')}</p></div></main>;
}

function AppContent() {
  const { t } = useI18n();
  const [session, setSession] = useState<Session>();
  const [setup, setSetup] = useState<PublicSetupInfo>();
  const [setupLoading, setSetupLoading] = useState(true);
  const [setupError, setSetupError] = useState<unknown>();
  const [checking, setChecking] = useState(true);
  const { route, go } = useRoute();
  useEffect(() => { adminApi.session().then(setSession).catch(() => setSession(undefined)).finally(() => setChecking(false)); }, []);
  useEffect(() => { adminApi.setup().then(setSetup).catch(setSetupError).finally(() => setSetupLoading(false)); }, []);
  const login = async (token: string) => { const next = await adminApi.login(token); setSession(next); };
  const logout = async () => { await adminApi.logout().catch(() => undefined); setSession(undefined); go('/'); };
  if (checking) return <main className="auth-screen"><Loading label={t('checkingSession')} /></main>;
  if (!session) return <Login onLogin={login} setup={setup} setupLoading={setupLoading} setupError={setupError} />;
  return <Console session={session} setup={setup} route={route} go={go} onLogout={logout} />;
}

function App() {
  return <I18nProvider><AppContent /></I18nProvider>;
}

function Console({ session, setup, route, go, onLogout }: { session: Session; setup?: PublicSetupInfo; route: Route; go: (path: string) => void; onLogout: () => Promise<void> }) {
  const { t, language } = useI18n();
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [repoError, setRepoError] = useState<unknown>();
  const [toast, setToast] = useState<string>();
  const refreshRepositories = useCallback(async () => { try { setRepoError(undefined); setRepositories(await adminApi.repositories()); } catch (error) { setRepoError(error); } }, []);
  useEffect(() => { void refreshRepositories(); }, [refreshRepositories]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(undefined), 4500); return () => window.clearTimeout(timer); }, [toast]);
  const currentRepo = route.repo ? repositories.find(repository => repository.full_name === route.repo) : undefined;
  const goRepo = (repo: string, tab: RepoTab = 'overview') => go(`/repositories/${encodeURIComponent(repo)}/${tab}`);
  return <div className="app-shell"><a className="skip-link" href="#main-content">{t('skipToMain')}</a><aside className="sidebar"><div className="sidebar-brand"><span className="brand-mark">P</span><span>PatchPaw</span></div><p className="nav-label">{t('controlPlane')}</p><nav aria-label={t('primaryNavigation')}><NavItem href="/repositories" active={route.section === 'repositories' && !route.repo} icon="grid" onClick={go}>{t('repositories')}</NavItem><NavItem href="/public-prompts" active={route.section === 'public-prompts'} icon="file" onClick={go}>{t('publicPrompts')}</NavItem><NavItem href="/public-skills" active={route.section === 'public-skills'} icon="spark" onClick={go}>{t('publicSkills')}</NavItem><NavItem href="/models" active={route.section === 'models'} icon="cube" onClick={go}>{t('models')}</NavItem><NavItem href="/workflow" active={route.section === 'workflow'} icon="workflow" onClick={go}><span>{t('workflow')} <small>P1</small></span></NavItem></nav><div className="sidebar-footer"><NavItem href="/settings" active={route.section === 'settings'} icon="gear" onClick={go}>{t('settings')}</NavItem><button className="logout-link" onClick={() => void onLogout()}><Icon name="logout" /> {t('signOut')}</button></div></aside><div className="main-column"><header className="topbar"><div className="mobile-brand"><span className="brand-mark">P</span><span>PatchPaw</span></div>{currentRepo ? <button className="context-chip" onClick={() => goRepo(currentRepo.full_name)}><span className="context-pulse" /><span>{currentRepo.full_name}</span><Icon name="chevron" size={14} /></button> : <span className="topbar-context">{t('operatorConsole')}</span>}<span className="session-state"><span className="online-dot" /> {t('sessionActiveUntil', { time: new Date(session.expires_at).toLocaleTimeString(language === 'zh-CN' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' }) })}</span></header><main id="main-content" className="content"><div className="mobile-nav"><Select aria-label={t('navigate')} value={route.repo ? `/repositories/${encodeURIComponent(route.repo)}/${route.tab ?? 'overview'}` : `/${route.section}`} onChange={event => go(event.target.value)}><option value="/repositories">{t('repositories')}</option><option value="/public-prompts">{t('publicPrompts')}</option><option value="/public-skills">{t('publicSkills')}</option><option value="/models">{t('models')}</option><option value="/workflow">{t('workflow')} (P1)</option><option value="/settings">{t('settings')}</option></Select></div>{Boolean(repoError) && <div className="inline-alert"><Icon name="warning" /> {repoError instanceof Error ? repoError.message : t('repositoryListUnavailable')}<button onClick={() => void refreshRepositories()}>{t('retry')}</button></div>}{route.repo ? <RepositoryPage repo={currentRepo} repoKey={route.repo} tab={route.tab ?? 'overview'} go={go} onRepositoryUpdated={updated => setRepositories(previous => previous.map(repository => repository.id === updated.id ? updated : repository))} onToast={setToast} /> : route.section === 'repositories' ? <RepositoriesPage repositories={repositories} onRefresh={refreshRepositories} onOpen={goRepo} onToast={setToast} /> : route.section === 'public-prompts' ? <AssetLibrary kind="prompt" scope="public" onToast={setToast} /> : route.section === 'public-skills' ? <AssetLibrary kind="skill" scope="public" onToast={setToast} /> : route.section === 'models' ? <ModelsPage onToast={setToast} /> : route.section === 'workflow' ? <WorkflowPage /> : <SettingsPage session={session} setup={setup} onLogout={onLogout} />}</main></div>{toast && <div className="toast" role="status"><Icon name="check" size={16} /> {toast}</div>}</div>;
}

function NavItem({ href, active, icon, children, onClick }: { href: string; active: boolean; icon: IconName; children: ReactNode; onClick: (href: string) => void }) {
  return <a className={`nav-item ${active ? 'active' : ''}`} href={href} aria-current={active ? 'page' : undefined} onClick={event => { event.preventDefault(); onClick(href); }}><Icon name={icon} /><span>{children}</span></a>;
}

function RepositoriesPage({ repositories, onRefresh, onOpen, onToast }: { repositories: Repository[]; onRefresh: () => Promise<void>; onOpen: (repo: string) => void; onToast: (message: string) => void }) {
  const { t, count } = useI18n();
  const [fullName, setFullName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const addRepository = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(undefined); try { const result = await adminApi.bootstrap(fullName.trim(), displayName.trim() || undefined); await onRefresh(); onToast(`${t('bootstrapRepository')}: ${result.repository.full_name}`); onOpen(result.repository.full_name); setFullName(''); setDisplayName(''); } catch (err) { setError(err); } finally { setBusy(false); } };
  return <><PageHeader eyebrow={t('repositories')} title={t('chooseRepository')} description={t('repositoryDescription')} actions={<Button variant="ghost" icon="refresh" onClick={() => void onRefresh()}>{t('refresh')}</Button>} /><div className="split-layout"><section className="panel repo-list-panel"><div className="panel-heading"><div><h2>{t('configuredRepositories')}</h2><p>{count(repositories.length, 'repository', 'repositoriesPlural')} {t('inThisControlPlane')}</p></div></div>{repositories.length === 0 ? <EmptyState title={t('noRepositoriesYet')} body={t('bootstrapRepositoryCopies')} /> : <div className="repo-list">{repositories.map(repository => <button className="repo-row" key={repository.id} onClick={() => onOpen(repository.full_name)}><span className="repo-avatar">{repository.display_name.slice(0, 1).toUpperCase()}</span><span className="repo-row-copy"><strong>{repository.display_name}</strong><span>{repository.full_name}</span></span><span className="repo-revision">rev {repository.revision}</span><Icon name="chevron" size={16} /></button>)}</div>}</section><section className="panel bootstrap-panel"><div className="panel-heading"><div><h2>{t('bootstrapRepository')}</h2><p>{t('copiesPublicAssets')}</p></div></div><form onSubmit={addRepository}><Field label={t('githubRepository')} hint={t('repositoryHint')} error={error instanceof ApiError && error.field === 'repo' ? error.message : undefined} required><TextInput value={fullName} onChange={event => setFullName(event.target.value)} placeholder={t('ownerRepository')} pattern="[^/]+/[^/]+" required /></Field><Field label={t('displayName')} hint={t('optionalConsoleLabel')}><TextInput value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder={t('widget')} /></Field>{Boolean(error) && !(error instanceof ApiError && error.field === 'repo') && <div className="form-error" role="alert">{error instanceof Error ? error.message : t('bootstrapFailed')}</div>}<Button type="submit" variant="primary" icon="plus" disabled={busy || !fullName.trim()}>{busy ? t('bootstrapping') : t('bootstrapRepository')}</Button></form></section></div></>;
}

function RepositoryPage({ repo, repoKey, tab, go, onRepositoryUpdated, onToast }: { repo?: Repository; repoKey: string; tab: RepoTab; go: (path: string) => void; onRepositoryUpdated: (repo: Repository) => void; onToast: (message: string) => void }) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [details, setDetails] = useState<Repository>();
  useEffect(() => { setLoading(true); setError(undefined); adminApi.repository(repoKey).then(setDetails).catch(setError).finally(() => setLoading(false)); }, [repoKey]);
  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={() => { setLoading(true); adminApi.repository(repoKey).then(setDetails).catch(setError).finally(() => setLoading(false)); }} />;
  const current = details ?? repo;
  if (!current) return <EmptyState title={t('repositoryNotFound')} body={t('repositoryNotConfigured')} action={<Button variant="primary" onClick={() => go('/repositories')}>{t('backToRepositories')}</Button>} />;
  const tabs: Array<[RepoTab, string, IconName]> = [['overview', t('overview'), 'grid'], ['prompts', t('prompts'), 'file'], ['skills', t('skills'), 'spark'], ['commands', t('commands'), 'cube'], ['conversation', t('conversationProfile'), 'workflow']];
  return <><div className="repo-header"><div><p className="eyebrow">{t('repositoryContext')}</p><h1>{current.display_name}</h1><p className="repo-full-name">{current.full_name}</p></div><Badge tone="success">{t('configurationActive')}</Badge></div><nav className="repo-tabs" aria-label={t('repositorySections')}>{tabs.map(([value, label, icon]) => <a key={value} href={`/repositories/${encodeURIComponent(repoKey)}/${value}`} className={tab === value ? 'active' : ''} aria-current={tab === value ? 'page' : undefined} onClick={event => { event.preventDefault(); go(`/repositories/${encodeURIComponent(repoKey)}/${value}`); }}><Icon name={icon} size={16} />{label}</a>)}</nav>{tab === 'overview' && <RepositoryOverview repository={current} repoKey={repoKey} onUpdated={updated => { onRepositoryUpdated(updated); setDetails(updated); onToast(t('repositoryNameSaved')); }} onToast={onToast} />}{tab === 'prompts' && <AssetLibrary kind="prompt" scope="repository" repo={repoKey} repository={current} onToast={onToast} />}{tab === 'skills' && <AssetLibrary kind="skill" scope="repository" repo={repoKey} repository={current} onToast={onToast} />}{tab === 'commands' && <CommandStudio repo={repoKey} onToast={onToast} />}{tab === 'conversation' && <ConversationProfilePage repo={repoKey} onToast={onToast} />}</>;
}

function RepositoryOverview({ repository, repoKey, onUpdated, onToast }: { repository: Repository; repoKey: string; onUpdated: (repo: Repository) => void; onToast: (message: string) => void }) {
  const { t } = useI18n();
  const [displayName, setDisplayName] = useState(repository.display_name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const save = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(undefined); try { onUpdated(await adminApi.updateRepository(repository, displayName.trim())); } catch (err) { setError(err); } finally { setBusy(false); } };
  return <><PageHeader eyebrow={t('overview')} title={t('repositorySettings')} description={t('overviewDescription')} /><div className="overview-grid"><section className="panel"><div className="panel-heading"><div><h2>{t('identity')}</h2><p>{t('stableRepositoryIdentity')}</p></div><Icon name="edit" /></div><form onSubmit={save}><Field label={t('displayName')} error={error instanceof ApiError && error.field === 'display_name' ? error.message : undefined} required><TextInput value={displayName} onChange={event => setDisplayName(event.target.value)} required /></Field>{Boolean(error) && !(error instanceof ApiError && error.field === 'display_name') && <div className="form-error" role="alert">{error instanceof Error ? error.message : t('couldNotSaveRepository')}</div>}<Button type="submit" variant="primary" icon="save" disabled={busy || !displayName.trim() || displayName === repository.display_name}>{busy ? t('saving') : t('saveChanges')}</Button></form></section><section className="panel"><div className="panel-heading"><div><h2>{t('configurationBoundary')}</h2><p>{t('managedByControlPlane')}</p></div></div><dl className="fact-list"><div><dt>{t('repositoryKey')}</dt><dd className="mono">{repoKey}</dd></div><div><dt>{t('currentRevision')}</dt><dd className="mono">{repository.revision}</dd></div><div><dt>{t('promptSkillScope')}</dt><dd>{t('repositoryCopies')}</dd></div><div><dt>{t('credentials')}</dt><dd>{t('managedInModels')}</dd></div></dl></section></div><section className="panel next-panel"><div><p className="eyebrow">{t('nextConfigurationSurface')}</p><h2>{t('conversationProfile')}</h2><p>{t('plainMentionsDedicated')}</p></div><Button variant="secondary" icon="arrow" onClick={() => { window.history.pushState({}, '', `/repositories/${encodeURIComponent(repoKey)}/conversation`); window.dispatchEvent(new PopStateEvent('popstate')); onToast(t('conversationProfileOpened')); }}>{t('editProfile')}</Button></section></>;
}

type AssetKind = 'prompt' | 'skill';
type AssetScope = 'public' | 'repository';
type Asset = PromptAsset | SkillAsset;

function AssetLibrary({ kind, scope, repo, repository, onToast }: { kind: AssetKind; scope: AssetScope; repo?: string; repository?: Repository; onToast: (message: string) => void }) {
  const { t, count } = useI18n();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [publicAssets, setPublicAssets] = useState<Asset[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [draft, setDraft] = useState<PromptPayload | SkillPayload>();
  const [isNew, setIsNew] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const load = useCallback(async () => {
    if (scope === 'repository' && !repo) return;
    setLoading(true); setError(undefined);
    try {
      const [items, publicItems] = scope === 'public'
        ? [kind === 'prompt' ? await adminApi.publicPrompts() : await adminApi.publicSkills(), []]
        : [kind === 'prompt' ? await adminApi.repositoryPrompts(repo!) : await adminApi.repositorySkills(repo!), kind === 'prompt' ? await adminApi.publicPrompts() : await adminApi.publicSkills()];
      setAssets(items); setPublicAssets(publicItems as Asset[]); setSelectedId(current => current && items.some(item => item.id === current) ? current : undefined); setIsNew(false); setDirty(false);
    } catch (err) { setError(err); } finally { setLoading(false); }
  }, [kind, scope, repo]);
  useEffect(() => { void load(); }, [load]);
  const selected = assets.find(asset => asset.id === selectedId);
  useEffect(() => {
    if (isNew) return;
    if (!selected) { setDraft(undefined); return; }
    setDraft(kind === 'prompt' ? { slug: selected.slug, title: selected.title, role: (selected as PromptAsset).role, content: selected.content, enabled: selected.enabled } : { slug: selected.slug, title: selected.title, description: (selected as SkillAsset).description, content: selected.content, enabled: selected.enabled });
    setDirty(false);
  }, [selected, kind, isNew]);
  useUnsavedChangesGuard(dirty);
  const title = kind === 'prompt' ? (scope === 'public' ? t('publicPrompts') : t('repositoryPrompts')) : (scope === 'public' ? t('publicSkills') : t('repositorySkills'));
  const kindLabel = kind === 'prompt' ? t('prompts') : t('skills');
  const selectAsset = (asset: Asset) => { if (dirty && !window.confirm(t('discardOpenAssetConfirm'))) return; setSelectedId(asset.id); setIsNew(false); };
  const newAsset = () => { if (dirty && !window.confirm(t('discardCreateAssetConfirm'))) return; setSelectedId(undefined); setIsNew(true); setDirty(true); setDraft(kind === 'prompt' ? { slug: '', title: '', role: null, content: t('newPromptTemplate'), enabled: true } : { slug: '', title: '', description: '', content: t('newSkillTemplate'), enabled: true }); };
  const change = <K extends keyof (PromptPayload & SkillPayload)>(key: K, value: (PromptPayload & SkillPayload)[K]) => { setDraft(previous => previous ? { ...previous, [key]: value } : previous); setDirty(true); };
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!draft) return; setSaving(true); setError(undefined);
    try {
      const saved = scope === 'public'
        ? (isNew ? (kind === 'prompt' ? await adminApi.createPublicPrompt(draft as PromptPayload) : await adminApi.createPublicSkill(draft as SkillPayload)) : (kind === 'prompt' ? await adminApi.updatePublicPrompt(selected as PromptAsset, draft as PromptPayload) : await adminApi.updatePublicSkill(selected as SkillAsset, draft as SkillPayload)))
        : (isNew ? (kind === 'prompt' ? await adminApi.createRepositoryPrompt(repo!, draft as PromptPayload) : await adminApi.createRepositorySkill(repo!, draft as SkillPayload)) : (kind === 'prompt' ? await adminApi.updateRepositoryPrompt(repo!, selected as PromptAsset, draft as PromptPayload) : await adminApi.updateRepositorySkill(repo!, selected as SkillAsset, draft as SkillPayload)));
      setAssets(previous => isNew ? [...previous, saved as Asset] : previous.map(asset => asset.id === (saved as Asset).id ? saved as Asset : asset)); setSelectedId((saved as Asset).id); setIsNew(false); setDirty(false); onToast(kind === 'prompt' ? t('promptSaved') : t('skillSaved'));
    } catch (err) { setError(err); } finally { setSaving(false); }
  };
  const remove = async () => { if (!selected || !window.confirm(t('deleteAssetConfirm', { title: selected.title }))) return; setSaving(true); setError(undefined); try { if (kind === 'prompt') scope === 'public' ? await adminApi.deletePublicPrompt(selected as PromptAsset) : await adminApi.deleteRepositoryPrompt(repo!, selected as PromptAsset); else scope === 'public' ? await adminApi.deletePublicSkill(selected as SkillAsset) : await adminApi.deleteRepositorySkill(repo!, selected as SkillAsset); setAssets(previous => previous.filter(asset => asset.id !== selected.id)); setSelectedId(undefined); setDraft(undefined); setDirty(false); onToast(kind === 'prompt' ? t('promptDeleted') : t('skillDeleted')); } catch (err) { setError(err); } finally { setSaving(false); } };
  const copy = async (source: Asset, replace: boolean) => { if (!repo || !repository) return; if (replace && !window.confirm(t('replaceRepositoryConfirm', { title: source.title }))) return; setSaving(true); setError(undefined); try { const copied = kind === 'prompt' ? await adminApi.copyPublicPrompt(repo, source.id, replace, repository.revision) : await adminApi.copyPublicSkill(repo, source.id, replace, repository.revision); setAssets(previous => previous.some(asset => asset.id === copied.id) ? previous.map(asset => asset.id === copied.id ? copied : asset) : [...previous, copied]); setSelectedId(copied.id); setIsNew(false); setDirty(false); onToast(replace ? t('repositoryCopyReplaced') : t('copiedToRepository')); } catch (err) { setError(err); } finally { setSaving(false); } };
  if (loading) return <Loading label={t('loadingConfiguration')} />;
  if (error && !draft) return <ErrorState error={error} onRetry={() => void load()} />;
  return <><PageHeader eyebrow={scope === 'public' ? t('sharedLibrary') : t('repositoryContext')} title={title} description={kind === 'prompt' ? t('longFormPromptDescription') : t('skillDescription')} />{draft ? (     <div className="detail-view-container">       <div className="detail-view-back"><Button variant="ghost" icon="arrow" onClick={() => { if (!dirty || window.confirm(t('discardChangesConfirm'))) { setDraft(undefined); setSelectedId(undefined); setIsNew(false); setDirty(false); } }}>{t('back') || '← 返回'}</Button></div>       <section className="panel editor-panel">         <form onSubmit={save}><div className="editor-heading"><div><p className="eyebrow">{isNew ? t('newAsset') : t('editableAsset')}</p><h2>{draft.title || `${t('untitled')} ${kindLabel}`}</h2></div><div className="editor-meta">{selected && <><Badge tone={selected.source_status === 'deleted' ? 'warning' : 'neutral'}>{selected.source_status === 'deleted' ? t('sourceDeleted') : t('revision', { revision: selected.revision })}</Badge>{dirty && <Badge tone="warning">{t('unsavedChanges')}</Badge>}</>}</div></div><div className="form-grid"><Field label={t('title')} required><TextInput value={draft.title} onChange={event => change('title', event.target.value)} maxLength={200} required /></Field><Field label={t('slug')} hint={t('stableBindingName')} required><TextInput value={draft.slug} onChange={event => change('slug', event.target.value)} pattern="[a-z][a-z0-9-]{0,63}" required /></Field>{kind === 'prompt' ? <Field label={t('engineRole')} hint={t('optionalResolverRole')}><TextInput value={(draft as PromptPayload).role ?? ''} onChange={event => change('role', event.target.value || null)} /></Field> : <Field label={t('description')}><TextInput value={(draft as SkillPayload).description ?? ''} onChange={event => change('description', event.target.value)} maxLength={1000} /></Field>}</div><Field label={t('enabled')}><label className="switch-line"><input type="checkbox" checked={draft.enabled ?? true} onChange={event => change('enabled', event.target.checked)} /><span className="switch" /><span>{draft.enabled ? t('availableForSelection') : t('disabledExcluded')}</span></label></Field><Field label={t('markdownContent')} hint={t('markdownHint')} required><textarea className="markdown-editor" value={draft.content} onChange={event => change('content', event.target.value)} spellCheck={false} required /></Field>{Boolean(error) && <div className="form-error" role="alert"><strong>{error instanceof ApiError && error.code === 'revision_conflict' ? t('assetChanged') : t('saveFailed')}</strong> {error instanceof Error ? error.message : ''}{error instanceof ApiError && error.requestId && <span className="mono"> {t('request', { id: error.requestId })}</span>}</div>}<div className="editor-actions"><Button type="submit" variant="primary" icon="save" disabled={saving || !dirty}>{saving ? t('savingChanges') : t('saveChanges')}</Button>{selected && <Button variant="danger" icon="trash" disabled={saving} onClick={() => void remove()}>{t('delete')}</Button>}{dirty && <Button variant="ghost" onClick={() => { setDirty(false); if (selected) setDraft(kind === 'prompt' ? { slug: selected.slug, title: selected.title, role: (selected as PromptAsset).role, content: selected.content, enabled: selected.enabled } : { slug: selected.slug, title: selected.title, description: (selected as SkillAsset).description, content: selected.content, enabled: selected.enabled }); else setDraft(undefined); }}>{t('discard')}</Button>}</div></form>       </section>     </div>   ) : (     <div className="list-view-container">       <div className="panel list-panel">         <div className="index-heading"><span>{count(assets.length, 'asset', 'assets')}</span><span className="index-rule" /></div>{assets.length === 0 ? <EmptyState title={kind === 'prompt' ? t('selectPrompt') : t('selectSkill')} body={t('selectAssetBody')} action={<Button variant="primary" icon="plus" onClick={newAsset}>{kind === 'prompt' ? t('createPrompt') : t('createSkill')}</Button>} /> : assets.map(asset => <button key={asset.id} className={`asset-row ${asset.id === selectedId ? 'active' : ''}`} onClick={() => selectAsset(asset)}><span className="asset-status" data-enabled={asset.enabled} /><span><strong>{asset.title || asset.slug}</strong><small>{asset.slug || t('untitled')} · rev {asset.revision}</small></span><Icon name="chevron" size={14} /></button>)}{assets.length > 0 && <div style={{ padding: '16px' }}><Button variant="secondary" icon="plus" onClick={newAsset} >{kind === 'prompt' ? t('createPrompt') : t('createSkill')}</Button></div>}{scope === 'repository' && publicAssets.length > 0 && <div className="public-source-list"><p className="index-heading">{t('publicSourceAssets')}</p>{publicAssets.map(source => <div className="source-row" key={source.id}><span><strong>{source.title || source.slug}</strong><small>{source.slug}</small></span><span className="source-actions"><Button variant="ghost" onClick={() => void copy(source, false)}>{t('copy')}</Button><Button variant="ghost" onClick={() => void copy(source, true)}>{t('replace')}</Button></span></div>)}</div>}       </div>     </div>   )}</>;
}

function ModelsPage({ onToast }: { onToast: (message: string) => void }) {
  const { t, count } = useI18n();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [draft, setDraft] = useState<ProviderPayload>();
  const [credential, setCredential] = useState('');
  const [newModel, setNewModel] = useState<ModelPayload>({ model_identifier: '', display_name: '', enabled: true });
  const [editingModels, setEditingModels] = useState<Record<string, ModelPayload>>({});
  const [newProvider, setNewProvider] = useState<ProviderPayload>({ type: 'zhipu', display_name: '', base_url: '', enabled: true });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const load = useCallback(async () => { setLoading(true); setError(undefined); try { const items = await adminApi.providers(); setProviders(items); setSelectedId(current => current && items.some(item => item.id === current) ? current : undefined); } catch (err) { setError(err); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  const provider = providers.find(item => item.id === selectedId);
  useEffect(() => { if (!provider) { setDraft(undefined); return; } setDraft({ type: provider.type, display_name: provider.display_name, base_url: provider.base_url, enabled: provider.enabled }); setCredential(''); setEditingModels(Object.fromEntries((provider.models ?? []).map(model => [model.id, { model_identifier: model.model_identifier, display_name: model.display_name, enabled: model.enabled }]))); }, [provider]);
  const saveProvider = async (event: FormEvent) => { event.preventDefault(); if (!provider || !draft) return; setBusy(true); setError(undefined); try { const saved = await adminApi.updateProvider(provider, draft); setProviders(previous => previous.map(item => item.id === saved.id ? { ...item, ...saved, models: item.models } : item)); onToast(t('providerSettingsSaved')); } catch (err) { setError(err); } finally { setBusy(false); } };
  const createProvider = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(undefined); try { const saved = await adminApi.createProvider(newProvider); setProviders(previous => [...previous, saved]); setSelectedId(saved.id); setNewProvider({ type: 'zhipu', display_name: '', base_url: '', enabled: true }); onToast(t('providerAdded')); } catch (err) { setError(err); } finally { setBusy(false); } };
  const setProviderCredential = async () => { if (!provider || !credential) return; setBusy(true); setError(undefined); try { const result = await adminApi.setCredential(provider, credential); setProviders(previous => previous.map(item => item.id === provider.id ? { ...item, credential_configured: result.configured, credential_ref: result.credential_ref, revision: item.revision + 1 } : item)); setCredential(''); onToast(t('credentialReplaced')); } catch (err) { setError(err); } finally { setBusy(false); } };
  const clearProviderCredential = async () => { if (!provider || !provider.credential_configured || !window.confirm(t('removeProviderCredentialConfirm'))) return; setBusy(true); setError(undefined); try { const result = await adminApi.clearCredential(provider); setProviders(previous => previous.map(item => item.id === provider.id ? { ...item, credential_configured: result.configured, credential_ref: result.credential_ref, revision: item.revision + 1 } : item)); onToast(t('credentialRemoved')); } catch (err) { setError(err); } finally { setBusy(false); } };
  const addModel = async (event: FormEvent) => { event.preventDefault(); if (!provider || !newModel.model_identifier.trim()) return; setBusy(true); setError(undefined); try { const model = await adminApi.createModel(provider, newModel); setProviders(previous => previous.map(item => item.id === provider.id ? { ...item, models: [...(item.models ?? []), model] } : item)); setNewModel({ model_identifier: '', display_name: '', enabled: true }); onToast(t('modelAdded')); } catch (err) { setError(err); } finally { setBusy(false); } };
  const saveModel = async (model: Model) => { if (!provider) return; setBusy(true); setError(undefined); try { const saved = await adminApi.updateModel(model, editingModels[model.id]); setProviders(previous => previous.map(item => item.id === provider.id ? { ...item, models: (item.models ?? []).map(candidate => candidate.id === model.id ? saved : candidate) } : item)); onToast(t('modelSaved')); } catch (err) { setError(err); } finally { setBusy(false); } };
  const deleteModel = async (model: Model) => { if (!window.confirm(t('deleteModelConfirm', { name: model.display_name || model.model_identifier }))) return; setBusy(true); setError(undefined); try { await adminApi.deleteModel(model); setProviders(previous => previous.map(item => item.id === provider?.id ? { ...item, models: (item.models ?? []).filter(candidate => candidate.id !== model.id) } : item)); onToast(t('modelDeleted')); } catch (err) { setError(err); } finally { setBusy(false); } };
  if (loading) return <Loading label={t('loadingModelProviders')} />;
  if (error && !provider && !draft) return <ErrorState error={error} onRetry={() => void load()} />;
  return <><PageHeader eyebrow={t('modelRegistry')} title={t('providersAndModels')} description={t('providerDescription')} />{!provider && !draft ? (  <div className="list-view-container">    <div className="providers-grid">      {providers.map(item => <button className="provider-card" key={item.id} onClick={() => { setSelectedId(item.id); }}>        <div className="provider-card-header">          <strong>{item.display_name}</strong>          <span className="asset-status" data-enabled={item.enabled} />        </div>        <div className="provider-card-body">          <span style={{ color: 'var(--dim)', fontSize: '14px' }}>{count(item.models?.length ?? 0, 'model', 'modelsPlural')}</span>          <small className="mono" style={{ marginLeft: 'auto', color: 'var(--dim)', opacity: 0.7 }}>{item.type}</small>        </div>      </button>)}      <button className="provider-card new-provider-card" onClick={() => { setSelectedId(undefined); setDraft({ type: 'zhipu', display_name: '', base_url: '', enabled: true }); }}>        <div className="provider-card-header" style={{ justifyContent: 'center', height: '100%', marginBottom: 0 }}>          <strong style={{ color: 'var(--accent)' }}>+ {t('addProvider')}</strong>        </div>      </button>    </div>  </div>) : (  <div className="detail-view-container">    <div className="detail-view-back"><Button variant="ghost" icon="arrow" onClick={() => { setDraft(undefined); setSelectedId(undefined); setNewProvider({ type: 'zhipu', display_name: '', base_url: '', enabled: true }); }}>{t('back') || '← 返回'}</Button></div>    <section className="panel provider-editor">      {!provider ? (        <><div className="editor-heading"><div><p className="eyebrow">{t('addProvider')}</p><h2>{t('addProvider')}</h2></div></div><form onSubmit={createProvider}><Field label={t('type')} required><Select value={newProvider.type} onChange={event => setNewProvider(previous => ({ ...previous, type: event.target.value as ProviderPayload['type'] }))}><option value="zhipu">Zhipu</option><option value="deepseek">DeepSeek</option><option value="openrouter">OpenRouter</option><option value="kimi">Kimi</option><option value="qwen">Qwen</option></Select></Field><Field label={t('displayName')} required><TextInput value={newProvider.display_name} onChange={event => setNewProvider(previous => ({ ...previous, display_name: event.target.value }))} required /></Field><Field label={t('baseUrl')} required><TextInput type="url" value={newProvider.base_url} onChange={event => setNewProvider(previous => ({ ...previous, base_url: event.target.value }))} placeholder="https://api.example.com/v1" required /></Field><Button type="submit" variant="secondary" icon="plus" disabled={busy || !newProvider.display_name || !newProvider.base_url}>{t('addProviderButton')}</Button></form></>      ) : provider && draft ? (        <><div className="editor-heading"><div><p className="eyebrow">{provider.type}</p><h2>{provider.display_name}</h2></div><Badge tone={provider.credential_configured ? 'success' : 'warning'}>{provider.credential_configured ? t('credentialConfigured') : t('credentialMissing')}</Badge></div><form onSubmit={saveProvider}><div className="form-grid"><Field label={t('displayName')} required><TextInput value={draft.display_name} onChange={event => setDraft({ ...draft as ProviderPayload, display_name: event.target.value })} required /></Field><Field label={t('baseUrl')} hint={t('onlyHttpUrl')} required><TextInput type="url" value={draft.base_url} onChange={event => setDraft({ ...draft as ProviderPayload, base_url: event.target.value })} required /></Field></div><Field label={t('enabled')}><label className="switch-line"><input type="checkbox" checked={draft.enabled ?? true} onChange={event => setDraft({ ...draft as ProviderPayload, enabled: event.target.checked })} /><span className="switch" /><span>{draft.enabled ? t('providerCanBeSelected') : t('providerDisabled')}</span></label></Field><Button type="submit" variant="primary" icon="save" disabled={busy}>{busy ? t('saving') : t('saveProvider')}</Button></form><div className="subsection credential-section"><div className="subsection-heading"><div><h3>{t('credential')}</h3><p>{t('credentialServerOnly')}</p></div><Icon name="lock" /></div><div className="credential-row"><TextInput type="password" value={credential} onChange={event => setCredential(event.target.value)} placeholder={t('replacementCredential')} autoComplete="new-password" aria-label={t('replacementProviderCredential')} /><Button variant="secondary" onClick={() => void setProviderCredential()} disabled={busy || !credential}>{t('replaceCredential')}</Button>{provider.credential_configured && <Button variant="danger" onClick={() => void clearProviderCredential()} disabled={busy}>{t('removeCredential')}</Button>}</div></div><div className="subsection"><div className="subsection-heading"><div><h3>{t('modelsHeading')}</h3><p>{t('modelsBody', { provider: provider.display_name })}</p></div><Badge tone="accent">{provider.models?.length ?? 0} {t('configured')}</Badge></div>{(provider.models ?? []).length > 0 && <div className="model-table" role="table" aria-label={`${provider.display_name} ${t('modelsHeading')}`}><div className="model-table-head" role="row"><span>{t('identifier')}</span><span>{t('displayName')}</span><span>{t('status')}</span><span>{t('actions')}</span></div>{(provider.models ?? []).map(model => <div className="model-row" role="row" key={model.id}><TextInput aria-label={`${model.model_identifier} ${t('identifier')}`} value={editingModels[model.id]?.model_identifier ?? model.model_identifier} onChange={event => setEditingModels(previous => ({ ...previous, [model.id]: { ...previous[model.id], model_identifier: event.target.value } }))} /><TextInput aria-label={`${model.model_identifier} ${t('displayName')}`} value={editingModels[model.id]?.display_name ?? model.display_name} onChange={event => setEditingModels(previous => ({ ...previous, [model.id]: { ...previous[model.id], display_name: event.target.value } }))} /><label className="table-toggle"><input type="checkbox" checked={editingModels[model.id]?.enabled ?? model.enabled} onChange={event => setEditingModels(previous => ({ ...previous, [model.id]: { ...previous[model.id], enabled: event.target.checked } }))} /> {editingModels[model.id]?.enabled ?? model.enabled ? t('enabled') : t('disabled')}</label><span className="row-actions"><Button variant="ghost" icon="save" onClick={() => void saveModel(model)}>{t('saveChanges')}</Button><Button variant="ghost" icon="trash" onClick={() => void deleteModel(model)}>{t('delete')}</Button></span></div>)}</div>}<form className="add-model-row" onSubmit={addModel}><TextInput aria-label={t('newModelIdentifier')} placeholder={t('modelIdentifier')} value={newModel.model_identifier} onChange={event => setNewModel(previous => ({ ...previous, model_identifier: event.target.value }))} required /><TextInput aria-label={t('newModelDisplayName')} placeholder={`${t('displayName')} (${t('optional')})`} value={newModel.display_name} onChange={event => setNewModel(previous => ({ ...previous, display_name: event.target.value }))} /><Button type="submit" variant="secondary" icon="plus" disabled={busy || !newModel.model_identifier.trim()}>{t('addModel')}</Button></form></div>{Boolean(error) && <div className="form-error" role="alert">{error instanceof ApiError && error.code === 'revision_conflict' ? t('configurationChanged') : error instanceof Error ? error.message : t('changeCouldNotBeSaved')}</div>}</>      ) : null}    </section>  </div>)}</>;
}

const executionKeys: Record<ExecutionType, MessageKey> = { custom: 'customCommand', review: 'review', repair: 'repair', ci: 'ciRepair', conflict: 'conflict' };
const permissionKeys: Record<Permission, MessageKey> = { read_only: 'readOnly', read_write: 'readWrite' };

function modelOptions(providers: Provider[]) {
  return providers.map(provider => ({ provider, models: (provider.models ?? []).filter(model => model.enabled) })).filter(group => group.models.length > 0);
}

function commandPayload(command: Command): CommandPayload {
  return { slash_name: command.slash_name, display_name: command.display_name, description: command.description, execution_type: command.execution_type,
    permission: command.permission, provider_model_id: command.provider_model_id, enabled: command.enabled,
    prompt_bindings: command.prompt_bindings.map(binding => ({ ...binding })), skill_bindings: command.skill_bindings.map(binding => ({ ...binding })) };
}

function ModelSelect({ providers, value, onChange }: { providers: Provider[]; value: string; onChange: (value: string) => void }) {
  const { t } = useI18n();
  const groups = modelOptions(providers);
  return <Select value={value} onChange={event => onChange(event.target.value)} required><option value="">{t('selectModel')}</option>{groups.map(group => <optgroup key={group.provider.id} label={group.provider.display_name}>{group.models.map(model => <option key={model.id} value={model.id}>{model.display_name || model.model_identifier} · {group.provider.display_name}</option>)}</optgroup>)}</Select>;
}

function OrderedBindings({ kind, bindings, assets, onChange }: { kind: AssetKind; bindings: PromptBinding[] | SkillBinding[]; assets: Asset[]; onChange: (bindings: PromptBinding[] | SkillBinding[]) => void }) {
  const { t } = useI18n();
  const move = (index: number, direction: -1 | 1) => { const next = [...bindings]; const target = index + direction; if (target < 0 || target >= next.length) return; [next[index], next[target]] = [next[target], next[index]]; onChange(next.map((binding, position) => ({ ...binding, position: position + 1 }))); };
  const remove = (index: number) => onChange(bindings.filter((_, candidate) => candidate !== index).map((binding, position) => ({ ...binding, position: position + 1 })));
  const add = (event: React.ChangeEvent<HTMLSelectElement>) => { const asset = assets.find(item => item.id === event.target.value); if (!asset) return; if (bindings.some(binding => binding.asset_id === asset.id)) { event.target.value = ''; return; } const binding = kind === 'prompt' ? { asset_id: asset.id, position: bindings.length + 1, enabled: true, binding_kind: 'main' as BindingKind } : { asset_id: asset.id, position: bindings.length + 1, enabled: true }; onChange([...bindings, binding]); event.target.value = ''; };
  return <div className="binding-editor"><div className="binding-list">{bindings.length === 0 && <p className="binding-empty">{kind === 'prompt' ? t('noPromptsSelected') : t('noSkillsSelected')}</p>}{bindings.map((binding, index) => { const asset = assets.find(item => item.id === binding.asset_id); return <div className="binding-row" key={`${binding.asset_id}-${index}`}><span className="binding-position">{index + 1}</span><span className="binding-name"><strong>{asset?.title ?? t('missingAsset')}</strong><small>{asset?.slug ?? binding.asset_id}</small></span>{kind === 'prompt' && <Select aria-label={t('promptBindingKind')} value={(binding as PromptBinding).binding_kind} onChange={event => onChange(bindings.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, binding_kind: event.target.value as BindingKind } : candidate)) as never}><option value="main">{t('main')}</option><option value="common">{t('common')}</option><option value="auxiliary">{t('auxiliary')}</option></Select>}<label className="binding-enabled"><input type="checkbox" checked={binding.enabled} onChange={event => onChange(bindings.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, enabled: event.target.checked } : candidate)) as never} /> {t('enabled')}</label><span className="row-actions"><Button variant="ghost" icon="up" onClick={() => move(index, -1)} disabled={index === 0}>{t('up')}</Button><Button variant="ghost" icon="down" onClick={() => move(index, 1)} disabled={index === bindings.length - 1}>{t('down')}</Button><Button variant="ghost" icon="trash" onClick={() => remove(index)}>{t('delete')}</Button></span></div>; })}</div><Select aria-label={kind === 'prompt' ? t('addPrompt') : t('addSkill')} defaultValue="" onChange={add}><option value="">{kind === 'prompt' ? t('addPrompt') : t('addSkill')}</option>{assets.filter(asset => !bindings.some(binding => binding.asset_id === asset.id)).map(asset => <option key={asset.id} value={asset.id}>{asset.title || asset.slug}</option>)}</Select></div>;
}


function CommandStudio({ repo, onToast }: { repo: string; onToast: (message: string) => void }) {
  const { t, count } = useI18n();
  const [commands, setCommands] = useState<Command[]>([]);
  const [prompts, setPrompts] = useState<PromptAsset[]>([]);
  const [skills, setSkills] = useState<SkillAsset[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedCommand, setSelectedCommand] = useState<Command>();
  const [draft, setDraft] = useState<CommandPayload>();
  const [isNew, setIsNew] = useState(false);
  const [effective, setEffective] = useState<EffectiveConfiguration>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const [dirty, setDirty] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setError(undefined);
    try {
      const [nextCommands, nextPrompts, nextSkills, nextProviders] = await Promise.all([adminApi.commands(repo), adminApi.repositoryPrompts(repo), adminApi.repositorySkills(repo), adminApi.providers()]);
      setCommands(nextCommands); setPrompts(nextPrompts); setSkills(nextSkills); setProviders(nextProviders);
    } catch (err) { setError(err); } finally { setLoading(false); }
  }, [repo]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const command = commands.find(candidate => candidate.id === selectedId);
    setSelectedCommand(command);
    if (command && !isNew) { setDraft(commandPayload(command)); setEffective(undefined); setDirty(false); }
  }, [commands, selectedId, isNew]);
  useUnsavedChangesGuard(dirty);
  const newCommand = () => {
    if (dirty && !window.confirm(t('discardCreateCommandConfirm'))) return;
    const firstModel = modelOptions(providers)[0]?.models[0]?.id ?? '';
    setSelectedId(undefined); setSelectedCommand(undefined); setIsNew(true); setEffective(undefined); setDirty(true);
    setDraft({ slash_name: '', display_name: '', description: '', execution_type: 'custom', permission: 'read_only', provider_model_id: firstModel, enabled: true, prompt_bindings: [], skill_bindings: [] });
  };
  const update = <K extends keyof CommandPayload>(key: K, value: CommandPayload[K]) => { setDraft(previous => previous ? { ...previous, [key]: value } : previous); setDirty(true); };
  const validate = () => {
    if (!draft) return t('createCommandFirst');
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(draft.slash_name)) return t('commandNameValidation');
    if (draft.execution_type === 'review' && draft.permission !== 'read_only') return t('reviewReadOnlyValidation');
    if (['repair', 'ci'].includes(draft.execution_type) && draft.permission !== 'read_write') return `${t(executionKeys[draft.execution_type])} ${t('commandsNeedReadWrite')}`;
    if (!draft.provider_model_id) return t('chooseModelForCommand');
    if (draft.enabled && !draft.prompt_bindings.some(binding => binding.enabled && binding.binding_kind === 'main')) return t('customMainPromptRequired');
    return undefined;
  };
  const save = async (event: FormEvent) => {
    event.preventDefault(); const validation = validate(); if (validation) { setError(new Error(validation)); return; }
    if (!draft) return; setSaving(true); setError(undefined);
    try {
      const saved = isNew ? await adminApi.createCommand(repo, draft) : await adminApi.updateCommand(repo, selectedCommand!, draft);
      setCommands(previous => isNew ? [...previous, saved] : previous.map(command => command.id === saved.id ? saved : command)); setSelectedId(saved.id); setIsNew(false); setDirty(false); onToast(t('commandSaved'));
    } catch (err) { setError(err); } finally { setSaving(false); }
  };
  const remove = async () => {
    if (!selectedCommand || !window.confirm(t('deleteCommandConfirm', { name: selectedCommand.slash_name }))) return;
    setSaving(true); setError(undefined); try { await adminApi.deleteCommand(repo, selectedCommand); setCommands(previous => previous.filter(command => command.id !== selectedCommand.id)); setSelectedId(undefined); setDraft(undefined); onToast(t('commandDeleted')); }
    catch (err) { setError(err); } finally { setSaving(false); }
  };
  const preview = async () => { if (!selectedCommand) return; setError(undefined); try { setEffective(await adminApi.effectiveCommand(repo, selectedCommand)); } catch (err) { setError(err); } };
  if (loading) return <Loading label={t('loadingCommandStudio')} />;
  if (error && !draft) return <ErrorState error={error} onRetry={() => void load()} />;
  return <>
    <PageHeader eyebrow={t('commandStudio')} title={t('commands')} description={t('commandDescription')} actions={!draft && <Button variant="primary" icon="plus" onClick={newCommand}>{t('newCommand')}</Button>} />
    {draft ? <div className="detail-view-container"><div className="detail-view-back"><Button variant="ghost" icon="arrow" onClick={() => { if (!dirty || window.confirm(t('discardChangesConfirm'))) { setDraft(undefined); setSelectedId(undefined); setIsNew(false); setDirty(false); } }}>{t('back') || '← 返回'}</Button></div>
      <section className="panel studio-panel"><form onSubmit={save}>
        <div className="editor-heading"><div><p className="eyebrow">{isNew ? t('newCommand') : t('commandConfiguration')}</p><h2>{draft.slash_name ? `/${draft.slash_name}` : t('unnamedCommand')}</h2></div><div className="editor-meta">{selectedCommand && <Badge tone="neutral">{t('revision', { revision: selectedCommand.revision })}</Badge>}{dirty && <Badge tone="warning">{t('unsavedChanges')}</Badge>}</div></div>
        <div className="form-grid"><Field label={t('commandName')} hint={t('commandNameHint')} required><TextInput value={draft.slash_name} onChange={event => update('slash_name', event.target.value)} placeholder="readme" required /></Field><Field label={t('displayName')} required><TextInput value={draft.display_name} onChange={event => update('display_name', event.target.value)} required /></Field></div>
        <Field label={t('description')}><textarea className="input compact-textarea" value={draft.description} onChange={event => update('description', event.target.value)} /></Field>
        <div className="form-grid"><Field label={t('executionTemplate')} required><Select value={draft.execution_type} onChange={event => { const execution = event.target.value as ExecutionType; update('execution_type', execution); if (execution === 'review') update('permission', 'read_only'); else if (execution === 'repair' || execution === 'ci') update('permission', 'read_write'); }}><option value="custom">{t('customCommand')}</option><option value="review">{t('review')}</option><option value="repair">{t('repair')}</option><option value="ci">{t('ciRepair')}</option><option value="conflict">{t('conflict')}</option></Select></Field><Field label={t('permission')} hint={t('permissionHint')}><Select value={draft.permission} onChange={event => update('permission', event.target.value as Permission)}><option value="read_only">{t('readOnly')}</option><option value="read_write">{t('readWrite')}</option></Select></Field></div>
        <Field label={t('modelsHeading')} hint={t('modelHint')} required><ModelSelect providers={providers} value={draft.provider_model_id} onChange={value => update('provider_model_id', value)} /></Field>
        {draft.execution_type === 'custom' && <div className="info-callout"><Icon name="lock" /><span>{t('customCommandHint')}</span></div>}
        {draft.execution_type === 'conflict' && draft.permission === 'read_only' && <div className="info-callout"><Icon name="lock" /><span>{t('conflictReadOnly')}</span></div>}
        <Field label={t('enabled')}><label className="switch-line"><input type="checkbox" checked={draft.enabled} onChange={event => update('enabled', event.target.checked)} /><span className="switch" /><span>{draft.enabled ? t('availableCommandParser') : t('disabledConversational')}</span></label></Field>
        <section className="stack-section"><div className="subsection-heading"><div><h3>{t('promptStack')}</h3><p>{draft.execution_type === 'custom' ? t('customPromptStackBody') : t('promptStackBody')}</p></div></div><OrderedBindings kind="prompt" bindings={draft.prompt_bindings} assets={prompts} onChange={bindings => update('prompt_bindings', bindings as PromptBinding[])} /></section>
        <section className="stack-section"><div className="subsection-heading"><div><h3>{t('skillStack')}</h3><p>{t('skillStackBody')}</p></div></div><OrderedBindings kind="skill" bindings={draft.skill_bindings} assets={skills} onChange={bindings => update('skill_bindings', bindings as SkillBinding[])} /></section>
        {Boolean(error) && <div className="form-error" role="alert">{error instanceof ApiError && error.code === 'revision_conflict' ? t('commandChanged') : error instanceof Error ? error.message : t('commandCouldNotSave')}</div>}
        <div className="editor-actions"><Button type="submit" variant="primary" icon="save" disabled={saving || !dirty}>{saving ? t('savingChanges') : t('saveCommand')}</Button>{selectedCommand && <><Button variant="secondary" icon="eye" onClick={() => void preview()}>{t('previewEffective')}</Button><Button variant="danger" icon="trash" disabled={saving} onClick={() => void remove()}>{t('delete')}</Button></>}{dirty && <Button variant="ghost" onClick={() => { setDirty(false); setDraft(selectedCommand ? commandPayload(selectedCommand) : undefined); setSelectedId(selectedCommand?.id); setIsNew(false); }}>{t('discard')}</Button>}</div>
      </form>{effective && <EffectivePreview effective={effective} />}</section></div> : <div className="list-view-container"><div className="panel list-panel"><div className="index-heading"><span>{count(commands.length, 'command', 'commandPlural')}</span></div>{commands.length === 0 ? <EmptyState title={t('noCommandsConfigured')} body={t('selectCommandBody')} action={<Button variant="primary" icon="plus" onClick={newCommand}>{t('createCommand')}</Button>} /> : commands.map(command => <button className={`command-row ${command.id === selectedId ? 'active' : ''}`} key={command.id} onClick={() => { if (dirty && !window.confirm(t('discardChangesConfirm'))) return; setIsNew(false); setSelectedId(command.id); }}><span className="command-slash">/{command.slash_name}</span><span><strong>{command.display_name}</strong><small>{t(executionKeys[command.execution_type])} · {t(permissionKeys[command.permission])}</small></span><span className="asset-status" data-enabled={command.enabled} /></button>)}</div></div>}
  </>;
}

function EffectivePreview({ effective }: { effective: EffectiveConfiguration }) {
  const { t } = useI18n();
  return <section className="effective-panel"><div className="subsection-heading"><div><p className="eyebrow">{t('resolverPreview')}</p><h3>{t('effectiveConfiguration')}</h3><p>{t('effectivePreviewBody')}</p></div><Badge tone="accent">{effective.permission === 'read_only' ? t('readOnly') : t('readWrite')}</Badge></div><div className="effective-facts"><span><small>{t('providerLabel')}</small><strong>{effective.provider.display_name}</strong></span><span><small>{t('modelsHeading')}</small><strong>{effective.model.display_name || effective.model.model_identifier}</strong></span><span><small>{t('output')}</small><strong>{effective.output_contract.kind}</strong></span><span><small>{t('snapshot')}</small><strong className="mono">{effective.snapshot_sha256.slice(0, 12)}…</strong></span></div><ol className="effective-parts">{effective.parts.map(part => <li key={`${part.kind}-${part.asset_id}-${part.position}`}><span>{part.kind === 'prompt' ? t('prompts') : t('skills')}</span><strong>{part.slug}</strong><small>{part.role ?? t('selectedBinding')} · rev {part.revision} · {part.sha256.slice(0, 10)}…</small></li>)}</ol></section>;
}

function ConversationProfilePage({ repo, onToast }: { repo: string; onToast: (message: string) => void }) {
  const { t } = useI18n();
  const [profile, setProfile] = useState<ConversationProfile>();
  const [prompts, setPrompts] = useState<PromptAsset[]>([]);
  const [skills, setSkills] = useState<SkillAsset[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [draft, setDraft] = useState<{ display_name: string; provider_model_id: string; enabled: boolean; prompt_bindings: PromptBinding[]; skill_bindings: SkillBinding[] }>();
  const [effective, setEffective] = useState<EffectiveConfiguration>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const [dirty, setDirty] = useState(false);
  const load = useCallback(async () => { setLoading(true); setError(undefined); try { const [nextProfile, nextPrompts, nextSkills, nextProviders] = await Promise.all([adminApi.profile(repo), adminApi.repositoryPrompts(repo), adminApi.repositorySkills(repo), adminApi.providers()]); setProfile(nextProfile); setPrompts(nextPrompts); setSkills(nextSkills); setProviders(nextProviders); setDraft({ display_name: nextProfile.display_name, provider_model_id: nextProfile.provider_model_id, enabled: nextProfile.enabled, prompt_bindings: nextProfile.prompt_bindings.map(binding => ({ ...binding })), skill_bindings: nextProfile.skill_bindings.map(binding => ({ ...binding })) }); setDirty(false); } catch (err) { setError(err); } finally { setLoading(false); } }, [repo]);
  useEffect(() => { void load(); }, [load]);
  useUnsavedChangesGuard(dirty);
  const update = <K extends keyof NonNullable<typeof draft>>(key: K, value: NonNullable<typeof draft>[K]) => { setDraft(previous => previous ? { ...previous, [key]: value } : previous); setDirty(true); };
  const save = async (event: FormEvent) => { event.preventDefault(); if (!profile || !draft) return; setSaving(true); setError(undefined); try { const saved = await adminApi.saveProfile(repo, profile, draft); setProfile(saved); setDirty(false); onToast(t('conversationProfileSaved')); } catch (err) { setError(err); } finally { setSaving(false); } };
  const preview = async () => { setError(undefined); try { setEffective(await adminApi.effectiveProfile(repo)); } catch (err) { setError(err); } };
  if (loading) return <Loading label={t('loadingConversation')} />;
  if (error && !draft) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!draft || !profile) return <EmptyState title={t('profileUnavailable')} body={t('profileUnavailableBody')} />;
  return <><PageHeader eyebrow={t('conversationProfile')} title={t('plainMentions')} description={t('profileDescription')} actions={<Badge tone="neutral">{t('readOnly')}</Badge>} /><section className="panel profile-panel"><div className="editor-heading"><div><p className="eyebrow">{t('repositoryOwnedProfile')}</p><h2>{draft.display_name || t('conversationProfile')}</h2></div><div className="editor-meta">{dirty && <Badge tone="warning">{t('unsavedChanges')}</Badge>}<Badge tone="neutral">{t('revision', { revision: profile.revision })}</Badge></div></div><form onSubmit={save}><div className="form-grid"><Field label={t('displayName')} required><TextInput value={draft.display_name} onChange={event => update('display_name', event.target.value)} required /></Field><Field label={t('modelsHeading')} hint={t('conversationModelHint')} required><ModelSelect providers={providers} value={draft.provider_model_id} onChange={value => update('provider_model_id', value)} /></Field></div><Field label={t('enabled')}><label className="switch-line"><input type="checkbox" checked={draft.enabled} onChange={event => update('enabled', event.target.checked)} /><span className="switch" /><span>{draft.enabled ? t('plainMentionsUseProfile') : t('conversationProfileDisabled')}</span></label></Field><section className="stack-section"><div className="subsection-heading"><div><h3>{t('promptStack')}</h3><p>{t('conversationPromptBody')}</p></div></div><OrderedBindings kind="prompt" bindings={draft.prompt_bindings} assets={prompts} onChange={bindings => update('prompt_bindings', bindings as PromptBinding[])} /></section><section className="stack-section"><div className="subsection-heading"><div><h3>{t('skillStack')}</h3><p>{t('conversationSkillBody')}</p></div></div><OrderedBindings kind="skill" bindings={draft.skill_bindings} assets={skills} onChange={bindings => update('skill_bindings', bindings as SkillBinding[])} /></section>{Boolean(error) && <div className="form-error" role="alert">{error instanceof ApiError && error.code === 'revision_conflict' ? t('profileChanged') : error instanceof Error ? error.message : t('profileCouldNotSave')}</div>}<div className="editor-actions"><Button type="submit" variant="primary" icon="save" disabled={saving || !dirty}>{saving ? t('savingChanges') : t('saveProfile')}</Button><Button variant="secondary" icon="eye" onClick={() => void preview()}>{t('previewEffective')}</Button><span className="form-note"><Icon name="lock" size={14} /> {t('permissionFixedReadOnly')}</span></div></form>{effective && <EffectivePreview effective={effective} />}</section></>;
}

function WorkflowPage() {
  const { t } = useI18n();
  return <><PageHeader eyebrow={t('plannedSurface')} title={t('workflow')} description={t('workflowDescription')} /><section className="workflow-placeholder panel"><div className="workflow-symbol"><Icon name="workflow" size={34} /></div><div><Badge tone="warning">{t('p1Planned')}</Badge><h2>{t('workflowsNotEnabled')}</h2><p>{t('workflowBody')}</p></div></section></>;
}

function SettingsPage({ session, setup, onLogout }: { session: Session; setup?: PublicSetupInfo; onLogout: () => Promise<void> }) {
  const { t, language, setLanguage } = useI18n();
  return <><PageHeader eyebrow={t('operatorSettings')} title={t('settings')} description={t('settingsDescription')} /><SetupGuide setup={setup} /><div className="settings-grid"><section className="panel"><div className="panel-heading"><div><h2>{t('session')}</h2><p>{t('cookieDescription')}</p></div><Icon name="lock" /></div><dl className="fact-list"><div><dt>{t('status')}</dt><dd><Badge tone="success">{t('authenticated')}</Badge></dd></div><div><dt>{t('expires')}</dt><dd>{new Date(session.expires_at).toLocaleString(language === 'zh-CN' ? 'zh-CN' : 'en-US')}</dd></div><div><dt>{t('credentialAccess')}</dt><dd>{t('neverReturned')}</dd></div><div><dt>{t('writeProtection')}</dt><dd>{t('sameOriginRequired')}</dd></div></dl><Button variant="danger" icon="logout" onClick={() => void onLogout()}>{t('signOut')}</Button><div className="settings-language"><div><h3>{t('language')}</h3><p>{t('languageDescription')}</p></div><label htmlFor="language-select">{t('interfaceLanguage')}</label><Select id="language-select" value={language} onChange={event => setLanguage(event.target.value as typeof language)}><option value="zh-CN">{t('simplifiedChinese')}</option><option value="en">{t('english')}</option></Select></div></section><section className="panel"><div className="panel-heading"><div><h2>{t('safetyBoundaries')}</h2><p>{t('safetyDescription')}</p></div></div><ul className="safety-list"><li><Icon name="check" /><span>{t('noProviderDiscovery')}</span></li><li><Icon name="check" /><span>{t('promptEditsStay')}</span></li><li><Icon name="check" /><span>{t('runningExecutions')}</span></li><li><Icon name="check" /><span>{t('workflowP1')}</span></li></ul></section></div></>;
}

export default App;
