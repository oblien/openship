/** One host-side sample, shared by HTTP and native server monitoring. */
export const SERVER_STATS_COMMAND = String.raw`(
  set -eu
  export LC_ALL=C
  case "$(uname -s)" in
    Darwin)
      # The final iostat row is an interval sample, not the average since boot.
      cpu_pct=$(iostat -c 2 -w 1 | awk 'END {
        if (NF < 6 || $(NF-3) !~ /^[0-9.]+$/) exit 1
        printf "%.0f", 100-$(NF-3)
      }')
      mem_t=$(sysctl -n hw.memsize)
      # vm_stat prints free, inactive and speculative pages separately.
      mem_a=$(vm_stat | awk '
        /page size of/ { p=$8 }
        /Pages free:/ { free=$3 }
        /Pages inactive:/ { inactive=$3 }
        /Pages speculative:/ { speculative=$3 }
        END { if (p <= 0) exit 1; printf "%.0f", (free+inactive+speculative)*p }
      ')
      boot_sec=$(sysctl -n kern.boottime | sed -n 's/.*{ sec = \([0-9]*\).*/\1/p')
      [ -n "$boot_sec" ]
      up_s=$(( $(date +%s) - boot_sec ))
      set -- $(sysctl -n vm.loadavg | tr -d '{}')
      l1=$1; l5=$2; l15=$3
      ;;
    Linux)
      # /proc/stat guest time is already included in user/nice. I/O wait is idle.
      cpu_sample() {
        awk '/^cpu / { printf "%.0f %.0f", $2+$3+$4+$5+$6+$7+$8+$9, $5+$6; exit }' /proc/stat
      }
      set -- $(cpu_sample)
      cpu0_total=$1; cpu0_idle=$2
      sleep 0.2
      set -- $(cpu_sample)
      cpu_d=$(( $1 - cpu0_total )); cpu_idle=$(( $2 - cpu0_idle ))
      if [ "$cpu_d" -gt 0 ]; then cpu_pct=$(( 100 - cpu_idle * 100 / cpu_d )); else cpu_pct=0; fi
      set -- $(awk '/MemTotal:/ {t=$2} /MemAvailable:/ {a=$2} END {printf "%.0f %.0f", t*1024, a*1024}' /proc/meminfo)
      mem_t=$1; mem_a=$2
      set -- $(cat /proc/uptime)
      up_s=$1
      set -- $(cat /proc/loadavg)
      l1=$1; l5=$2; l15=$3
      ;;
    *) printf '%s\n' 'Unsupported server operating system' >&2; exit 1 ;;
  esac
  [ "$mem_t" -gt 0 ]
  [ "$mem_a" -le "$mem_t" ] || mem_a=$mem_t
  mem_u=$(( mem_t - mem_a ))
  [ "$cpu_pct" -ge 0 ] || cpu_pct=0
  [ "$cpu_pct" -le 100 ] || cpu_pct=100
  # POSIX df works on both hosts. Fixed-point output avoids shell arithmetic on
  # scientific notation for large disks/memory. No here-strings or temp files.
  set -- $(df -Pk / | awk 'NR==2 {printf "%.0f %.0f %.0f", $2*1024, $3*1024, $4*1024}')
  disk_t=$1; disk_u=$2; disk_a=$3
  [ "$disk_t" -gt 0 ]
  printf '{"cpu":%d,"memTotal":%s,"memUsed":%s,"memAvail":%s,"diskTotal":%s,"diskUsed":%s,"diskAvail":%s,"uptime":"%s","load1":"%s","load5":"%s","load15":"%s"}\n' "$cpu_pct" "$mem_t" "$mem_u" "$mem_a" "$disk_t" "$disk_u" "$disk_a" "$up_s" "$l1" "$l5" "$l15"
)`;
