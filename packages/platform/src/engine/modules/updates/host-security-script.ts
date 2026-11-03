/** Compiled, reviewed operation. The signed feed supplies data only. */
export const HOST_SECURITY_SCRIPT = String.raw`
import base64, json, os, platform, shlex, sys, subprocess
import apt, apt_pkg
from apt.progress.base import OpProgress, AcquireProgress, InstallProgress

args = json.loads(base64.b64decode(sys.argv[1]))
mode = args['mode']
apt_pkg.init()
apt_pkg.config.set('APT::Get::AllowUnauthenticated', 'false')
apt_pkg.config.set('APT::Install-Recommends', 'false')
apt_pkg.config.set('Acquire::http::Timeout', '20')
apt_pkg.config.set('Acquire::https::Timeout', '20')
apt_pkg.config.set('Acquire::Retries', '0')
apt_pkg.config.set('Dpkg::Options::', '--force-confold')
os.environ['DEBIAN_FRONTEND'] = 'noninteractive'
os.environ['NEEDRESTART_MODE'] = 'l'

# Use python-apt's native progress callbacks, on the same stdout log pipe.
# https://apt-team.pages.debian.net/python-apt/library/apt.progress.base.html
class Downloads(AcquireProgress):
    def fetch(self, item):
        super().fetch(item)
        print('Downloading: ' + item.shortdesc, flush=True)
    def fail(self, item):
        super().fail(item)
        print('Download failed: ' + item.shortdesc, flush=True)

class Installation(InstallProgress):
    def status_change(self, pkg, percent, status):
        super().status_change(pkg, percent, status)
        print('Install %d%%: %s — %s' % (percent, pkg, status), flush=True)
    def error(self, pkg, errormsg):
        super().error(pkg, errormsg)
        print('Install failed: %s — %s' % (pkg, errormsg), flush=True)

def emit(value):
    print('OPENSHIP_HOST_SECURITY=' + json.dumps(value, separators=(',', ':')), flush=True)

def release_info():
    result = {}
    with open('/etc/os-release') as f:
        for line in f:
            if '=' in line and not line.startswith('#'):
                key, value = line.rstrip().split('=', 1)
                parsed = shlex.split(value)
                result[key] = parsed[0] if parsed else ''
    return result

osr = release_info()
if osr.get('ID') != 'ubuntu':
    raise RuntimeError('Host patching currently supports Ubuntu with python3-apt.')
# A container can report the host kernel but cannot patch it. Refuse that boundary.
container = any(os.path.exists(p) for p in ('/.dockerenv', '/run/.containerenv', '/run/systemd/container'))
if os.path.exists('/usr/bin/systemd-detect-virt'):
    container = container or subprocess.run(['/usr/bin/systemd-detect-virt', '--container', '--quiet'], timeout=5).returncode == 0
if container:
    raise RuntimeError('The connection must execute on the server host, outside containers.')
with open('/proc/sys/kernel/random/boot_id') as f:
    boot = f.read().strip()
kernel = platform.release()


def allowed(version):
    suite = osr.get('VERSION_CODENAME')
    origins = [o for o in version.origins if o.archive != 'now']
    return bool(origins) and all(o.trusted and o.origin == 'Ubuntu' and
        o.archive in (suite, suite + '-updates', suite + '-security') for o in origins)

def inspect(cache):
    rows = []
    kernel_pkg = cache.get('linux-image-' + kernel)
    running = kernel_pkg.installed if kernel_pkg else None
    for entry in args['targets']:
        target = entry['target']
        if osr.get('VERSION_ID') != target['release']:
            continue
        pkg = cache.get(target['package'])
        installed = pkg.installed if pkg else None
        candidate = pkg.candidate if pkg else None
        k = target.get('runningKernel')
        running_fixed = None
        if k and running and running.source_name == k['sourcePackage']:
            running_fixed = apt_pkg.version_compare(running.source_version, k['fixedVersion']) >= 0
        if not installed and running_fixed is not False:
            continue
        package_fixed = bool(installed and apt_pkg.version_compare(installed.version, target['fixedVersion']) >= 0)
        state = 'fixed' if package_fixed and (not k or running_fixed is True) else 'affected'
        if k and package_fixed and running_fixed is False:
            state = 'reboot_required'
        if k and running_fixed is None:
            state = 'unknown'
        can_patch = bool(installed and candidate and not package_fixed and
            apt_pkg.version_compare(candidate.version, target['fixedVersion']) >= 0 and allowed(candidate))
        rows.append(dict(key=entry['key'], package=target['package'], installed=installed.version if installed else None,
            candidate=candidate.version if can_patch else None, state=state, canPatch=can_patch and state == 'affected',
            runningVersion=running.source_version if k and running else None))
    return dict(distribution='ubuntu', release=osr.get('VERSION_ID', ''), bootId=boot, kernel=kernel,
        rebootRequired=os.path.exists('/var/run/reboot-required'), rows=rows)

def prepare(cache):
    observation = inspect(cache)
    for row in observation['rows']:
        if row['state'] != 'fixed':
            if not row['canPatch']:
                raise RuntimeError('A supported stable patch is unavailable, a reboot is pending, or this kernel needs manual review.')
            pkg = cache[row['package']]
            if pkg._pkg.selected_state == apt_pkg.SELSTATE_HOLD:
                raise RuntimeError('The affected package is held. Review its hold manually.')
            pkg.mark_install(auto_fix=True, auto_inst=True, from_user=True)
    if cache.broken_count or cache.delete_count or cache.dpkg_journal_dirty:
        raise RuntimeError('APT requires manual repair or would remove packages.')
    changes = []
    for pkg in cache.get_changes():
        before = pkg.installed.version if pkg.installed else None
        version = pkg.candidate
        if pkg.marked_delete or not version or not allowed(version) or (before and apt_pkg.version_compare(version.version, before) < 0):
            raise RuntimeError('The patch would remove, downgrade or use an unsupported package origin.')
        if pkg._pkg.selected_state == apt_pkg.SELSTATE_HOLD:
            raise RuntimeError('The patch would change a held package.')
        changes.append(dict(package=pkg.name, previous=before, version=version.version))
    if not changes or len(changes) > 100:
        raise RuntimeError('No applicable bounded package update is available.')
    changes.sort(key=lambda row: row['package'])
    return dict(observation=observation, changes=changes)

if mode in ('plan-reboot', 'reboot'):
    observation = inspect(apt.Cache(progress=OpProgress()))
    if not observation['rows'] or not any(r['state'] == 'reboot_required' for r in observation['rows']) or any(r['state'] not in ('fixed', 'reboot_required') for r in observation['rows']):
        raise RuntimeError('The installed kernel update must be verified before rebooting.')
    plan = dict(observation=observation, changes=[])
    if mode == 'reboot':
        if plan != args['expected']:
            raise RuntimeError('The server changed. Review the reboot again.')
        subprocess.run(['/usr/sbin/shutdown', '-r', '+1', 'Openship: approved security kernel reboot'], check=True, timeout=10)
        emit(observation)
    else:
        emit(plan)
elif mode == 'inspect':
    emit(inspect(apt.Cache(progress=OpProgress())))
else:
    # Holding APT's frontend lock across planning and commit closes the stale-plan race.
    with apt_pkg.SystemLock():
        cache = apt.Cache(progress=OpProgress())
        if mode == 'plan':
            cache.update()
            cache.open(progress=OpProgress())
        plan = prepare(cache)
        if mode == 'apply':
            if plan != args['expected']:
                raise RuntimeError('The server or package plan changed. Review a new plan.')
            print('Installing the reviewed security packages. Services may restart.', flush=True)
            # Minimal/cloud Ubuntu images sometimes omit APT's download directory.
            os.makedirs(os.path.join(apt_pkg.config.find_dir('Dir::Cache::archives'), 'partial'), mode=0o755, exist_ok=True)
            if not cache.commit(fetch_progress=Downloads(), install_progress=Installation(), allow_unauthenticated=False):
                raise RuntimeError('APT did not finish the patch.')
            cache.open(progress=OpProgress())
            emit(inspect(cache))
        else:
            emit(plan)
`;
