import { useEffect, useMemo, useState, type ReactElement } from 'react';
import * as Device from 'expo-device';
import * as Crypto from 'expo-crypto';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { StatusBar } from 'expo-status-bar';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type {
  CompanionHostStatus,
  CompanionPairingQr,
  CompanionTaskSummary,
  CompanionWorkspaceSummary,
} from '@lnwjud/companion-contracts';
import {
  cancelTask,
  getHostStatus,
  listTasks,
  listWorkspaces,
  refreshSession,
  registerDevice,
} from './src/api';
import { ensureDevicePublicKey } from './src/device-identity';
import { parsePairingPayload, type StoredCompanionSession } from './src/protocol';
import { clearSession, getOrCreateDeviceId, loadSession, saveSession } from './src/secure-session';

type Tab = 'home' | 'tasks' | 'approvals' | 'settings';

interface DashboardData {
  readonly host: CompanionHostStatus;
  readonly workspaces: readonly CompanionWorkspaceSummary[];
  readonly tasks: readonly CompanionTaskSummary[];
  readonly tasksAvailable: boolean;
}

export default function App(): ReactElement {
  const [session, setSession] = useState<StoredCompanionSession | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [host, setHost] = useState<CompanionHostStatus | null>(null);
  const [workspaces, setWorkspaces] = useState<readonly CompanionWorkspaceSummary[]>([]);
  const [tasks, setTasks] = useState<readonly CompanionTaskSummary[]>([]);
  const [tasksAvailable, setTasksAvailable] = useState(true);
  const [cancellingTaskId, setCancellingTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('home');

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const stored = await loadSession();
        if (stored === null || cancelled) return;
        const tokens = await refreshSession(stored.publicOrigin, stored.refreshToken);
        const rotated = { ...stored, refreshToken: tokens.refreshToken };
        await saveSession(rotated);
        const dashboard = await loadDashboard(rotated.publicOrigin, tokens.accessToken);
        if (cancelled) return;
        setSession(rotated);
        setAccessToken(tokens.accessToken);
        applyDashboard(dashboard, setHost, setWorkspaces, setTasks, setTasksAvailable);
      } catch (cause: unknown) {
        await clearSession().catch(() => undefined);
        if (!cancelled) setError(messageOf(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return (): void => { cancelled = true; };
  }, []);

  async function connect(pairedSession: StoredCompanionSession, token: string): Promise<void> {
    setSession(pairedSession);
    setAccessToken(token);
    setError(null);
    setLoading(true);
    try {
      const dashboard = await loadDashboard(pairedSession.publicOrigin, token);
      applyDashboard(dashboard, setHost, setWorkspaces, setTasks, setTasksAvailable);
      setTab('home');
    } finally {
      setLoading(false);
    }
  }

  async function reload(): Promise<void> {
    if (session === null) return;
    setLoading(true);
    setError(null);
    try {
      let activeSession = session;
      let token = accessToken;
      if (token === null) {
        const refreshed = await refreshSession(activeSession.publicOrigin, activeSession.refreshToken);
        activeSession = { ...activeSession, refreshToken: refreshed.refreshToken };
        await saveSession(activeSession);
        setSession(activeSession);
        setAccessToken(refreshed.accessToken);
        token = refreshed.accessToken;
      }
      let dashboard: DashboardData;
      try {
        dashboard = await loadDashboard(activeSession.publicOrigin, token);
      } catch (cause: unknown) {
        if (!isUnauthorized(cause)) throw cause;
        const refreshed = await refreshSession(activeSession.publicOrigin, activeSession.refreshToken);
        activeSession = { ...activeSession, refreshToken: refreshed.refreshToken };
        await saveSession(activeSession);
        setSession(activeSession);
        setAccessToken(refreshed.accessToken);
        dashboard = await loadDashboard(activeSession.publicOrigin, refreshed.accessToken);
      }
      applyDashboard(dashboard, setHost, setWorkspaces, setTasks, setTasksAvailable);
    } catch (cause: unknown) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }

  async function cancelFromPhone(taskId: string): Promise<void> {
    if (session === null || accessToken === null || cancellingTaskId !== null) return;
    setCancellingTaskId(taskId);
    setError(null);
    try {
      let activeSession = session;
      let token = accessToken;
      try {
        await cancelTask(activeSession.publicOrigin, token, taskId, `cancel-${Crypto.randomUUID()}`);
      } catch (cause: unknown) {
        if (!isUnauthorized(cause)) throw cause;
        const refreshed = await refreshSession(activeSession.publicOrigin, activeSession.refreshToken);
        activeSession = { ...activeSession, refreshToken: refreshed.refreshToken };
        await saveSession(activeSession);
        setSession(activeSession);
        setAccessToken(refreshed.accessToken);
        token = refreshed.accessToken;
        await cancelTask(activeSession.publicOrigin, token, taskId, `cancel-${Crypto.randomUUID()}`);
      }
      const dashboard = await loadDashboard(activeSession.publicOrigin, token);
      applyDashboard(dashboard, setHost, setWorkspaces, setTasks, setTasksAvailable);
    } catch (cause: unknown) {
      if (isForbidden(cause)) setTasksAvailable(false);
      setError(messageOf(cause));
    } finally {
      setCancellingTaskId(null);
    }
  }

  async function forgetLocalSession(): Promise<void> {
    await clearSession();
    setSession(null);
    setAccessToken(null);
    setHost(null);
    setWorkspaces([]);
    setTasks([]);
    setTasksAvailable(true);
    setCancellingTaskId(null);
    setTab('home');
    setError(null);
  }

  if (loading && session === null) return <LoadingScreen />;
  if (session === null) {
    return <PairScreen error={error} onConnected={connect} onError={setError} />;
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <View style={styles.appShell}>
        <Header host={host} loading={loading} onRefresh={() => { void reload(); }} />
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {error === null ? null : <Alert text={error} />}
          {tab === 'home' ? <Home host={host} workspaces={workspaces} /> : null}
          {tab === 'tasks' ? (
            <TasksPage
              tasks={tasks}
              available={tasksAvailable}
              cancellingTaskId={cancellingTaskId}
              onCancel={(taskId) => { void cancelFromPhone(taskId); }}
            />
          ) : null}
          {tab === 'approvals' ? <Placeholder title="Approvals" detail="Device-bound exact-action approvals arrive in M5." /> : null}
          {tab === 'settings' ? <Settings session={session} host={host} onForget={() => { void forgetLocalSession(); }} /> : null}
        </ScrollView>
        <TabBar tab={tab} setTab={setTab} />
      </View>
    </SafeAreaView>
  );
}

function PairScreen(props: {
  readonly error: string | null;
  readonly onConnected: (session: StoredCompanionSession, accessToken: string) => Promise<void>;
  readonly onError: (message: string | null) => void;
}): ReactElement {
  const [pairing, setPairing] = useState<CompanionPairingQr | null>(null);
  const [pairingCode, setPairingCode] = useState('');
  const [manualPayload, setManualPayload] = useState('');
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

  async function startScanner(): Promise<void> {
    props.onError(null);
    const granted = permission?.granted === true ? permission : await requestPermission();
    if (!granted.granted) {
      props.onError('Camera permission is required to scan the lnwjud Desktop pairing QR code.');
      return;
    }
    setScanning(true);
  }

  function acceptPayload(raw: string): void {
    try {
      const parsed = parsePairingPayload(raw.trim());
      setPairing(parsed);
      setScanning(false);
      setManualPayload('');
      props.onError(null);
    } catch (cause: unknown) {
      props.onError(messageOf(cause));
    }
  }

  async function pair(): Promise<void> {
    if (pairing === null) return;
    setBusy(true);
    props.onError(null);
    try {
      const deviceId = await getOrCreateDeviceId();
      const publicKeyJwk = await ensureDevicePublicKey();
      const platform = Platform.OS === 'ios' ? 'ios' as const : 'android' as const;
      const tokens = await registerDevice({
        pairing,
        pairingCode,
        deviceId,
        deviceName: Device.deviceName?.trim() || `lnwjud ${platform}`,
        platform,
        publicKeyJwk,
      });
      if (tokens.device.deviceId !== deviceId) throw new Error('Desktop returned a mismatched device identity.');
      const nextSession: StoredCompanionSession = {
        hostId: pairing.hostId,
        publicOrigin: pairing.publicOrigin,
        deviceId,
        refreshToken: tokens.refreshToken,
      };
      await saveSession(nextSession);
      await props.onConnected(nextSession, tokens.accessToken);
    } catch (cause: unknown) {
      props.onError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <KeyboardAvoidingView style={styles.pairShell} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.pairContent} keyboardShouldPersistTaps="handled">
          <View style={styles.brandMark}><Text style={styles.brandMarkText}>L</Text></View>
          <Text style={styles.eyebrow}>LNWJUD COMPANION</Text>
          <Text style={styles.heroTitle}>Your desktop, within reach.</Text>
          <Text style={styles.heroBody}>Pair one trusted phone to view lnwjud host and workspace status without exposing raw MCP or a remote shell.</Text>

          {props.error === null ? null : <Alert text={props.error} />}

          {scanning ? (
            <View style={styles.scannerCard}>
              <CameraView
                style={styles.camera}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={(result: BarcodeScanningResult) => acceptPayload(result.data)}
              />
              <Text style={styles.scannerHint}>Point the camera at the “Pair Mobile” QR on lnwjud Desktop.</Text>
              <SecondaryButton label="Cancel scan" onPress={() => setScanning(false)} />
            </View>
          ) : null}

          <View style={styles.card}>
            <Text style={styles.cardTitle}>{pairing === null ? '1 · Scan Desktop' : '1 · Desktop found'}</Text>
            {pairing === null ? (
              <>
                <PrimaryButton label="Scan pairing QR" onPress={() => { void startScanner(); }} />
                <Text style={styles.orLabel}>or paste pairing data</Text>
                <TextInput
                  value={manualPayload}
                  onChangeText={setManualPayload}
                  multiline
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="{ pairing QR JSON }"
                  placeholderTextColor="#5F6878"
                  style={[styles.input, styles.payloadInput]}
                />
                <SecondaryButton label="Use pairing data" disabled={manualPayload.trim().length === 0} onPress={() => acceptPayload(manualPayload)} />
              </>
            ) : (
              <>
                <View style={styles.hostRow}>
                  <View style={styles.onlineDot} />
                  <View style={styles.hostCopy}>
                    <Text style={styles.hostName}>Trusted Desktop</Text>
                    <Text numberOfLines={1} style={styles.muted}>{pairing.publicOrigin}</Text>
                  </View>
                  <Pressable onPress={() => setPairing(null)}><Text style={styles.link}>Change</Text></Pressable>
                </View>
                <Text style={styles.fieldLabel}>2 · Enter the 6-digit code</Text>
                <TextInput
                  value={pairingCode}
                  onChangeText={(value) => setPairingCode(value.replace(/\D/g, '').slice(0, 6))}
                  keyboardType="number-pad"
                  textContentType="oneTimeCode"
                  placeholder="000000"
                  placeholderTextColor="#4B5360"
                  style={[styles.input, styles.pinInput]}
                  maxLength={6}
                />
                <Text style={styles.muted}>The code and QR both expire automatically. The private device key never leaves this phone.</Text>
                <PrimaryButton label={busy ? 'Pairing…' : 'Pair this phone'} disabled={busy || pairingCode.length !== 6} onPress={() => { void pair(); }} />
              </>
            )}
          </View>
          <Text style={styles.securityFoot}>P-256 hardware-backed identity · encrypted credential storage · HTTPS only</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Header(props: { readonly host: CompanionHostStatus | null; readonly loading: boolean; readonly onRefresh: () => void }): ReactElement {
  return (
    <View style={styles.header}>
      <View>
        <Text style={styles.headerBrand}>lnwjud</Text>
        <Text style={styles.headerSub}>{props.host?.hostName ?? 'Companion'}</Text>
      </View>
      <Pressable style={styles.refreshButton} disabled={props.loading} onPress={props.onRefresh}>
        {props.loading ? <ActivityIndicator size="small" /> : <Text style={styles.refreshText}>Refresh</Text>}
      </Pressable>
    </View>
  );
}

function Home(props: { readonly host: CompanionHostStatus | null; readonly workspaces: readonly CompanionWorkspaceSummary[] }): ReactElement {
  const host = props.host;
  const activeCount = useMemo(() => props.workspaces.filter((workspace) => workspace.active).length, [props.workspaces]);
  return (
    <>
      <Text style={styles.pageEyebrow}>CONTROL PLANE</Text>
      <Text style={styles.pageTitle}>Home</Text>
      <View style={styles.statusHero}>
        <View style={styles.statusTopLine}>
          <View style={styles.onlineDotLarge} />
          <Text style={styles.statusWord}>{host?.online === true ? 'DESKTOP ONLINE' : 'STATUS UNKNOWN'}</Text>
        </View>
        <Text style={styles.statusHost}>{host?.hostName ?? 'Connecting…'}</Text>
        <Text style={styles.muted}>{host === null ? '—' : `${host.platform} · ${host.arch} · lnwjud ${host.appVersion}`}</Text>
      </View>
      <View style={styles.metricGrid}>
        <Metric label="Active projects" value={String(activeCount)} />
        <Metric label="Running tasks" value={String(host?.runningTaskCount ?? 0)} />
        <Metric label="Approvals" value={String(host?.pendingApprovalCount ?? 0)} />
      </View>
      <Text style={styles.sectionTitle}>Workspaces</Text>
      {props.workspaces.length === 0 ? <Text style={styles.emptyText}>No project workspace is currently available.</Text> : props.workspaces.map((workspace) => (
        <View key={workspace.id} style={styles.workspaceRow}>
          <View style={[styles.workspaceGlyph, workspace.active && styles.workspaceGlyphActive]}><Text style={styles.workspaceGlyphText}>{workspace.displayName.slice(0, 1).toUpperCase()}</Text></View>
          <View style={styles.hostCopy}>
            <Text style={styles.workspaceName}>{workspace.displayName}</Text>
            <Text style={styles.muted}>{workspace.active ? 'Active project' : 'Available'}</Text>
          </View>
          <Text style={workspace.active ? styles.activeBadge : styles.idleBadge}>{workspace.active ? 'ACTIVE' : 'READY'}</Text>
        </View>
      ))}
    </>
  );
}

function TasksPage(props: {
  readonly tasks: readonly CompanionTaskSummary[];
  readonly available: boolean;
  readonly cancellingTaskId: string | null;
  readonly onCancel: (taskId: string) => void;
}): ReactElement {
  return (
    <>
      <Text style={styles.pageEyebrow}>DURABLE WORK</Text>
      <Text style={styles.pageTitle}>Tasks</Text>
      {!props.available ? (
        <View style={styles.warningCard}>
          <Text style={styles.warningTitle}>Pair again to enable task access</Text>
          <Text style={styles.muted}>This phone was paired before M4 task scopes were available. lnwjud never upgrades an existing refresh token silently. Forget or revoke this device, then pair it again from Desktop.</Text>
        </View>
      ) : props.tasks.length === 0 ? (
        <View style={styles.placeholderCard}>
          <Text style={styles.placeholderGlyph}>◇</Text>
          <Text style={styles.placeholderTitle}>No durable tasks</Text>
          <Text style={styles.heroBody}>Owned task providers have nothing active or recently tracked for the registered workspaces.</Text>
        </View>
      ) : props.tasks.map((task) => (
        <TaskCard
          key={task.taskId}
          task={task}
          cancelling={props.cancellingTaskId === task.taskId}
          onCancel={() => props.onCancel(task.taskId)}
        />
      ))}
    </>
  );
}

function TaskCard(props: { readonly task: CompanionTaskSummary; readonly cancelling: boolean; readonly onCancel: () => void }): ReactElement {
  const task = props.task;
  return (
    <View style={styles.taskCard}>
      <View style={styles.taskTopLine}>
        <Text style={styles.taskKind}>{taskKindLabel(task.kind)}</Text>
        <Text style={[styles.taskState, task.state === 'running' && styles.taskStateRunning]}>{taskStateLabel(task.state)}</Text>
      </View>
      <Text style={styles.taskTitle}>{task.title}</Text>
      {task.progressLabel === null ? null : <Text style={styles.taskProgress}>{task.progressLabel}</Text>}
      {task.resultSummary === null ? null : <Text style={styles.muted}>{task.resultSummary}</Text>}
      <View style={styles.taskMetaRow}>
        <Text style={styles.taskMeta}>Updated {formatTaskTime(task.updatedAt)}</Text>
        <Text style={styles.taskMeta}>{shortId(task.taskId)}</Text>
      </View>
      {task.cancellable ? (
        <SecondaryButton label={props.cancelling ? 'Cancelling…' : 'Cancel task'} disabled={props.cancelling} onPress={props.onCancel} />
      ) : null}
    </View>
  );
}

function Settings(props: { readonly session: StoredCompanionSession; readonly host: CompanionHostStatus | null; readonly onForget: () => void }): ReactElement {
  return (
    <>
      <Text style={styles.pageEyebrow}>TRUSTED DEVICE</Text>
      <Text style={styles.pageTitle}>Settings</Text>
      <View style={styles.card}>
        <InfoRow label="Desktop" value={props.host?.hostName ?? props.session.hostId} />
        <InfoRow label="Origin" value={props.session.publicOrigin} />
        <InfoRow label="Device ID" value={shortId(props.session.deviceId)} />
        <InfoRow label="Credential" value="SecureStore · rotating refresh" />
        <InfoRow label="Private key" value="Hardware-backed · non-exportable" />
      </View>
      <View style={styles.warningCard}>
        <Text style={styles.warningTitle}>Forget local session</Text>
        <Text style={styles.muted}>This removes the refresh credential from this phone. Revoke the device on lnwjud Desktop to invalidate server-side trust.</Text>
        <SecondaryButton label="Forget on this phone" onPress={props.onForget} />
      </View>
    </>
  );
}

function Placeholder(props: { readonly title: string; readonly detail: string }): ReactElement {
  return (
    <>
      <Text style={styles.pageEyebrow}>COMING NEXT</Text>
      <Text style={styles.pageTitle}>{props.title}</Text>
      <View style={styles.placeholderCard}>
        <Text style={styles.placeholderGlyph}>◇</Text>
        <Text style={styles.placeholderTitle}>Foundation ready</Text>
        <Text style={styles.heroBody}>{props.detail}</Text>
      </View>
    </>
  );
}

function TabBar(props: { readonly tab: Tab; readonly setTab: (tab: Tab) => void }): ReactElement {
  const entries: readonly [Tab, string, string][] = [
    ['home', '⌂', 'Home'],
    ['tasks', '≡', 'Tasks'],
    ['approvals', '✓', 'Approvals'],
    ['settings', '⚙', 'Settings'],
  ];
  return (
    <View style={styles.tabBar}>
      {entries.map(([id, glyph, label]) => (
        <Pressable key={id} style={styles.tabItem} onPress={() => props.setTab(id)}>
          <Text style={[styles.tabGlyph, props.tab === id && styles.tabActive]}>{glyph}</Text>
          <Text style={[styles.tabLabel, props.tab === id && styles.tabActive]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function Metric(props: { readonly label: string; readonly value: string }): ReactElement {
  return <View style={styles.metric}><Text style={styles.metricValue}>{props.value}</Text><Text style={styles.metricLabel}>{props.label}</Text></View>;
}

function InfoRow(props: { readonly label: string; readonly value: string }): ReactElement {
  return <View style={styles.infoRow}><Text style={styles.infoLabel}>{props.label}</Text><Text numberOfLines={2} style={styles.infoValue}>{props.value}</Text></View>;
}

function Alert(props: { readonly text: string }): ReactElement {
  return <View style={styles.alert}><Text style={styles.alertText}>{props.text}</Text></View>;
}

function PrimaryButton(props: { readonly label: string; readonly onPress: () => void; readonly disabled?: boolean }): ReactElement {
  return <Pressable style={[styles.primaryButton, props.disabled === true && styles.disabled]} disabled={props.disabled} onPress={props.onPress}><Text style={styles.primaryButtonText}>{props.label}</Text></Pressable>;
}

function SecondaryButton(props: { readonly label: string; readonly onPress: () => void; readonly disabled?: boolean }): ReactElement {
  return <Pressable style={[styles.secondaryButton, props.disabled === true && styles.disabled]} disabled={props.disabled} onPress={props.onPress}><Text style={styles.secondaryButtonText}>{props.label}</Text></Pressable>;
}

function LoadingScreen(): ReactElement {
  return <SafeAreaView style={[styles.safe, styles.loading]}><StatusBar style="light" /><ActivityIndicator size="large" /><Text style={styles.loadingText}>Opening secure session…</Text></SafeAreaView>;
}

async function loadDashboard(publicOrigin: string, accessToken: string): Promise<DashboardData> {
  const [host, workspaces, taskState] = await Promise.all([
    getHostStatus(publicOrigin, accessToken),
    listWorkspaces(publicOrigin, accessToken),
    readTasks(publicOrigin, accessToken),
  ]);
  return { host, workspaces, tasks: taskState.tasks, tasksAvailable: taskState.available };
}

async function readTasks(publicOrigin: string, accessToken: string): Promise<{ readonly available: boolean; readonly tasks: readonly CompanionTaskSummary[] }> {
  try {
    return { available: true, tasks: await listTasks(publicOrigin, accessToken) };
  } catch (cause: unknown) {
    if (isForbidden(cause)) return { available: false, tasks: [] };
    throw cause;
  }
}

function applyDashboard(
  dashboard: DashboardData,
  setHost: (value: CompanionHostStatus) => void,
  setWorkspaces: (value: readonly CompanionWorkspaceSummary[]) => void,
  setTasks: (value: readonly CompanionTaskSummary[]) => void,
  setTasksAvailable: (value: boolean) => void,
): void {
  setHost(dashboard.host);
  setWorkspaces(dashboard.workspaces);
  setTasks(dashboard.tasks);
  setTasksAvailable(dashboard.tasksAvailable);
}

function taskKindLabel(kind: CompanionTaskSummary['kind']): string {
  if (kind === 'durable_goal') return 'DURABLE GOAL';
  if (kind === 'managed_task') return 'MANAGED TASK';
  return kind.toUpperCase();
}

function taskStateLabel(state: CompanionTaskSummary['state']): string {
  return state.replaceAll('_', ' ').toUpperCase();
}

function formatTaskTime(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isUnauthorized(error: unknown): boolean { return typeof error === 'object' && error !== null && 'status' in error && (error as { readonly status?: unknown }).status === 401; }
function isForbidden(error: unknown): boolean { return typeof error === 'object' && error !== null && 'status' in error && (error as { readonly status?: unknown }).status === 403; }
function shortId(value: string): string { return value.length <= 18 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`; }

const GOLD = '#E6C45B';
const BG = '#070A10';
const CARD = '#111722';
const BORDER = '#242D3A';
const MUTED = '#919CAC';
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  loading: { alignItems: 'center', justifyContent: 'center', gap: 14 },
  loadingText: { color: MUTED, fontSize: 14 },
  appShell: { flex: 1 },
  header: { paddingHorizontal: 22, paddingTop: 10, paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BORDER, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerBrand: { color: GOLD, fontSize: 19, fontWeight: '800', letterSpacing: -0.5 },
  headerSub: { color: MUTED, fontSize: 12, marginTop: 2 },
  refreshButton: { minWidth: 74, minHeight: 36, borderWidth: 1, borderColor: BORDER, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  refreshText: { color: '#D8DEE8', fontSize: 12, fontWeight: '700' },
  content: { padding: 22, paddingBottom: 40 },
  pairShell: { flex: 1 },
  pairContent: { paddingHorizontal: 24, paddingTop: 42, paddingBottom: 48 },
  brandMark: { width: 52, height: 52, borderRadius: 16, borderWidth: 1, borderColor: '#806A2F', backgroundColor: '#171408', alignItems: 'center', justifyContent: 'center', marginBottom: 24 },
  brandMarkText: { color: GOLD, fontSize: 26, fontWeight: '900' },
  eyebrow: { color: GOLD, fontSize: 11, fontWeight: '800', letterSpacing: 2.2 },
  heroTitle: { color: '#F4F6FA', fontSize: 38, lineHeight: 42, fontWeight: '800', letterSpacing: -1.4, marginTop: 12 },
  heroBody: { color: '#A7B0BF', fontSize: 15, lineHeight: 23, marginTop: 12 },
  card: { backgroundColor: CARD, borderWidth: 1, borderColor: BORDER, borderRadius: 20, padding: 18, marginTop: 24 },
  cardTitle: { color: '#F0F2F6', fontSize: 16, fontWeight: '800', marginBottom: 16 },
  scannerCard: { marginTop: 22, backgroundColor: CARD, borderRadius: 20, borderWidth: 1, borderColor: BORDER, overflow: 'hidden', paddingBottom: 16 },
  camera: { width: '100%', aspectRatio: 1 },
  scannerHint: { color: MUTED, fontSize: 12, lineHeight: 18, margin: 16, marginBottom: 0 },
  input: { color: '#F5F6F8', backgroundColor: '#090D13', borderWidth: 1, borderColor: '#303A49', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13, fontSize: 15 },
  payloadInput: { minHeight: 88, textAlignVertical: 'top' },
  pinInput: { fontSize: 28, fontWeight: '800', letterSpacing: 10, textAlign: 'center', marginTop: 9, marginBottom: 12 },
  fieldLabel: { color: '#D9DEE7', fontSize: 13, fontWeight: '700', marginTop: 20 },
  primaryButton: { minHeight: 50, borderRadius: 13, backgroundColor: GOLD, alignItems: 'center', justifyContent: 'center', marginTop: 14, paddingHorizontal: 16 },
  primaryButtonText: { color: '#18130A', fontSize: 15, fontWeight: '900' },
  secondaryButton: { minHeight: 46, borderRadius: 12, borderWidth: 1, borderColor: '#384353', alignItems: 'center', justifyContent: 'center', marginTop: 12, paddingHorizontal: 16 },
  secondaryButtonText: { color: '#D9DEE7', fontSize: 14, fontWeight: '700' },
  disabled: { opacity: 0.42 },
  orLabel: { color: '#697486', fontSize: 11, textAlign: 'center', marginVertical: 13, textTransform: 'uppercase', letterSpacing: 1.2 },
  securityFoot: { color: '#697486', fontSize: 11, lineHeight: 17, textAlign: 'center', marginTop: 18 },
  alert: { backgroundColor: '#291517', borderWidth: 1, borderColor: '#693138', padding: 13, borderRadius: 12, marginTop: 18 },
  alertText: { color: '#FFB0B5', fontSize: 13, lineHeight: 19 },
  hostRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  onlineDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#64D99A' },
  hostCopy: { flex: 1 },
  hostName: { color: '#F0F3F8', fontSize: 14, fontWeight: '800' },
  muted: { color: MUTED, fontSize: 12, lineHeight: 18 },
  link: { color: GOLD, fontSize: 12, fontWeight: '800' },
  pageEyebrow: { color: GOLD, fontSize: 10, fontWeight: '800', letterSpacing: 2 },
  pageTitle: { color: '#F5F6F8', fontSize: 34, fontWeight: '800', letterSpacing: -1, marginTop: 7, marginBottom: 18 },
  statusHero: { backgroundColor: '#0E151D', borderWidth: 1, borderColor: '#234333', borderRadius: 20, padding: 20 },
  statusTopLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  onlineDotLarge: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#5FDC98', shadowColor: '#5FDC98', shadowOpacity: 0.45, shadowRadius: 8 },
  statusWord: { color: '#70E3A7', fontSize: 11, fontWeight: '900', letterSpacing: 1.4 },
  statusHost: { color: '#F5F7FA', fontSize: 24, fontWeight: '800', marginTop: 13, marginBottom: 4 },
  metricGrid: { flexDirection: 'row', gap: 10, marginTop: 12 },
  metric: { flex: 1, minHeight: 88, backgroundColor: CARD, borderWidth: 1, borderColor: BORDER, borderRadius: 16, padding: 13, justifyContent: 'space-between' },
  metricValue: { color: '#F4F6FA', fontSize: 23, fontWeight: '800' },
  metricLabel: { color: MUTED, fontSize: 10, lineHeight: 14 },
  sectionTitle: { color: '#E9ECF2', fontSize: 15, fontWeight: '800', marginTop: 26, marginBottom: 10 },
  workspaceRow: { minHeight: 70, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BORDER },
  workspaceGlyph: { width: 36, height: 36, borderRadius: 10, backgroundColor: '#171E28', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: BORDER },
  workspaceGlyphActive: { borderColor: '#6C5B29', backgroundColor: '#1C190E' },
  workspaceGlyphText: { color: '#DCE2EB', fontWeight: '800' },
  workspaceName: { color: '#EDF0F5', fontSize: 14, fontWeight: '700' },
  activeBadge: { color: GOLD, fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  idleBadge: { color: '#657082', fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  emptyText: { color: MUTED, fontSize: 13, lineHeight: 20 },
  taskCard: { backgroundColor: CARD, borderWidth: 1, borderColor: BORDER, borderRadius: 18, padding: 16, marginBottom: 12 },
  taskTopLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  taskKind: { color: GOLD, fontSize: 9, fontWeight: '900', letterSpacing: 1.1 },
  taskState: { color: '#8994A6', fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  taskStateRunning: { color: '#70E3A7' },
  taskTitle: { color: '#F1F3F7', fontSize: 16, fontWeight: '800', marginTop: 10, marginBottom: 5 },
  taskProgress: { color: '#CCD3DE', fontSize: 13, lineHeight: 19, marginBottom: 4 },
  taskMetaRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, marginTop: 12 },
  taskMeta: { color: '#626D7E', fontSize: 10, flexShrink: 1 },
  tabBar: { minHeight: 72, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: BORDER, backgroundColor: '#090D13', flexDirection: 'row', paddingBottom: Platform.OS === 'ios' ? 8 : 2 },
  tabItem: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3 },
  tabGlyph: { color: '#667184', fontSize: 19, fontWeight: '700' },
  tabLabel: { color: '#667184', fontSize: 9, fontWeight: '700' },
  tabActive: { color: GOLD },
  infoRow: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BORDER },
  infoLabel: { color: '#687486', fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 },
  infoValue: { color: '#E6EAF0', fontSize: 13, lineHeight: 19 },
  warningCard: { marginTop: 16, padding: 18, borderRadius: 18, borderWidth: 1, borderColor: '#42382A', backgroundColor: '#17130D' },
  warningTitle: { color: '#F0D79D', fontSize: 15, fontWeight: '800', marginBottom: 7 },
  placeholderCard: { minHeight: 230, borderRadius: 20, borderWidth: 1, borderColor: BORDER, backgroundColor: CARD, alignItems: 'center', justifyContent: 'center', padding: 28 },
  placeholderGlyph: { color: GOLD, fontSize: 40 },
  placeholderTitle: { color: '#F0F3F7', fontSize: 18, fontWeight: '800', marginTop: 10 },
});
