"""Boot one disposable, separately networked Linux VM inside its Docker wrapper.

The guest takes the wrapper's allocated address and MAC, so Docker's existing
network isolation and loopback-only SSH port forward remain authoritative.
Only this container's interfaces and its two labelled fixture volumes change.
"""
import base64
import json
import os
from pathlib import Path
import stat
import subprocess


def run(*args):
    return subprocess.check_output(args, text=True).strip()


if not Path("/dev/kvm").exists():
    raise RuntimeError("Shared-storage E2E requires a Linux Docker host with /dev/kvm.")
with open("/dev/kvm", "rb+"):
    pass

name = os.environ["OPENSHIP_E2E_NAME"]
key = base64.b64decode(os.environ["OPENSHIP_E2E_PUBLIC_KEY"]).decode().strip()
route = next(r for r in json.loads(run("ip", "-j", "route")) if r["dst"] == "default")
interface = route["dev"]
link = json.loads(run("ip", "-j", "addr", "show", "dev", interface))[0]
address = next(a for a in link["addr_info"] if a["family"] == "inet")
mac = link["address"]

userdata = {
    "users": [{"name": "root", "lock_passwd": True, "ssh_authorized_keys": [key]}],
    "disable_root": False,
    "ssh_pwauth": False,
    "package_update": False,
    "package_upgrade": False,
    "disk_setup": {"/dev/vdb": {"table_type": "gpt", "layout": True, "overwrite": False}},
    "fs_setup": [{"device": "/dev/vdb1", "filesystem": "ext4", "label": "openship-data"}],
    "mounts": [["LABEL=openship-data", "/var/lib/openship", "ext4", "defaults", "0", "2"]],
    "runcmd": [
        ["systemctl", "disable", "--now", "apt-daily.timer", "apt-daily-upgrade.timer"],
        ["systemctl", "stop", "unattended-upgrades"],
    ],
}
network = {"version": 2, "ethernets": {"eth0": {
    "match": {"macaddress": mac}, "set-name": "eth0", "dhcp4": False,
    "addresses": [f"{address['local']}/{address['prefixlen']}"],
    "routes": [{"to": "default", "via": route["gateway"]}],
    "nameservers": {"addresses": ["1.1.1.1", "8.8.8.8"]},
}}}
Path("/tmp/user-data").write_text("#cloud-config\n" + json.dumps(userdata))
Path("/tmp/meta-data").write_text(json.dumps({"instance-id": name, "local-hostname": name}))
Path("/tmp/network-config").write_text(json.dumps(network))
run("cloud-localds", "--network-config=/tmp/network-config", "/tmp/seed.img", "/tmp/user-data", "/tmp/meta-data")
if not Path("/var/lib/rancher/host.qcow2").exists():
    run("qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", "/image/noble-server-cloudimg-amd64.img", "/var/lib/rancher/host.qcow2", "24G")
if not Path("/var/lib/openship/storage.img").exists():
    run("qemu-img", "create", "-f", "raw", "/var/lib/openship/storage.img", "12G")

# Avoid the bridge treating frames for the guest MAC as its own local traffic.
parts = mac.split(":")
parts[-1] = f"{int(parts[-1], 16) ^ 0x80:02x}"
run("ip", "link", "add", "br0", "type", "bridge")
run("ip", "addr", "flush", "dev", interface)
run("ip", "link", "set", interface, "down")
run("ip", "link", "set", interface, "address", ":".join(parts))
run("ip", "link", "set", interface, "master", "br0")
run("ip", "link", "set", interface, "up")
run("ip", "link", "set", "br0", "up")
Path("/dev/net").mkdir(exist_ok=True)
if not Path("/dev/net/tun").exists():
    os.mknod("/dev/net/tun", stat.S_IFCHR | 0o600, os.makedev(10, 200))
run("ip", "tuntap", "add", "dev", "tap0", "mode", "tap")
run("ip", "link", "set", "tap0", "master", "br0")
run("ip", "link", "set", "tap0", "up")

args = ["qemu-system-x86_64", "-enable-kvm", "-cpu", "host", "-smp", "2", "-m", "2048",
        "-display", "none", "-serial", "stdio", "-monitor", "none", "-no-reboot",
        "-drive", "file=/var/lib/rancher/host.qcow2,if=virtio,format=qcow2,cache=none",
        "-drive", "file=/var/lib/openship/storage.img,if=virtio,format=raw,cache=none",
        "-drive", "file=/tmp/seed.img,if=virtio,format=raw,readonly=on",
        "-netdev", "tap,id=net0,ifname=tap0,script=no,downscript=no",
        "-device", f"virtio-net-pci,netdev=net0,mac={mac}"]
os.execvp(args[0], args)
