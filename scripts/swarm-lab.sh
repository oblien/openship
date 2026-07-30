#!/bin/sh
# Disposable Docker Swarm lab. It creates only the fixed openship-swarm-lab
# Compose project, a nested ordinary Compose Traefik fixture, and the
# openship-swarm-fixture and openship-swarm-managed-fixture stacks; cleanup
# refuses every other target. See
# docs/swarm/TEST-MATRIX.md.
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
compose_file="$repo_root/fixtures/swarm/lab.compose.yml"
stack_file="$repo_root/fixtures/swarm/stack.yml"
compose_traefik_file="$repo_root/fixtures/swarm/compose-traefik.yml"
lab_project="openship-swarm-lab"
compose_traefik_project="openship-compose-traefik-fixture"
manager="openship-swarm-lab-manager"
worker="openship-swarm-lab-worker"
fixture_stack="openship-swarm-fixture"
managed_stack="openship-swarm-managed-fixture"
managed_config="openship_lab_config"
managed_secret="openship_lab_secret"
manager_host="tcp://127.0.0.1:23750"

usage() {
  echo "Usage: scripts/swarm-lab.sh {up|deploy|compose-proxy|status|observe-proof|managed-proof|operations-proof|events|cleanup|down}" >&2
  exit 64
}

require_docker() {
  command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
  docker info >/dev/null 2>&1 || { echo "Docker daemon is not reachable" >&2; exit 1; }
}

require_lab() {
  docker inspect "$manager" >/dev/null 2>&1 || {
    echo "Swarm lab is not running; run scripts/swarm-lab.sh up first" >&2
    exit 1
  }
}

wait_for_dind() {
  name="$1"
  attempts=0
  until docker exec "$name" docker info >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 45 ]; then
      echo "$name did not become ready" >&2
      exit 1
    fi
    sleep 2
  done
}

wait_for_stack_removal() {
  stack_name="$1"
  attempts=0
  while :; do
    services=$(docker -H "$manager_host" service ls --filter "label=com.docker.stack.namespace=$stack_name" -q)
    network=$(docker -H "$manager_host" network ls --filter "name=${stack_name}_default" -q)
    if [ -z "$services" ] && [ -z "$network" ]; then
      return
    fi
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 30 ]; then
      echo "Timed out waiting for disposable stack $stack_name to be removed" >&2
      exit 1
    fi
    sleep 1
  done
}

ensure_managed_persistent_objects() {
  if ! docker -H "$manager_host" config inspect "$managed_config" >/dev/null 2>&1; then
    printf '%s\n' 'openship managed lab config' | docker -H "$manager_host" config create "$managed_config" - >/dev/null
  fi
  if ! docker -H "$manager_host" secret inspect "$managed_secret" >/dev/null 2>&1; then
    # The disposable value never enters process output; only presence is later
    # asserted through metadata-only discovery.
    printf '%s\n' 'openship-managed-lab-secret-value' | docker -H "$manager_host" secret create "$managed_secret" - >/dev/null
  fi
}

remove_managed_persistent_objects() {
  docker -H "$manager_host" config rm "$managed_config" >/dev/null 2>&1 || true
  docker -H "$manager_host" secret rm "$managed_secret" >/dev/null 2>&1 || true
}

start_lab() {
  docker compose -p "$lab_project" -f "$compose_file" up -d
  wait_for_dind "$manager"
  wait_for_dind "$worker"

  manager_state=$(docker exec "$manager" docker info --format '{{.Swarm.LocalNodeState}}')
  if [ "$manager_state" != "active" ]; then
    manager_address=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$manager")
    test -n "$manager_address" || { echo "Could not resolve lab manager address" >&2; exit 1; }
    docker exec "$manager" docker swarm init --advertise-addr "$manager_address"
  fi

  worker_state=$(docker exec "$worker" docker info --format '{{.Swarm.LocalNodeState}}')
  if [ "$worker_state" != "active" ]; then
    manager_address=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$manager")
    worker_token=$(docker exec "$manager" docker swarm join-token -q worker)
    docker exec "$worker" docker swarm join --token "$worker_token" "$manager_address:2377"
  fi

  docker exec "$manager" docker node ls
}

case "${1:-}" in
  up)
    require_docker
    start_lab
    ;;
  deploy)
    require_docker
    require_lab
    docker -H "$manager_host" stack deploy --detach=false -c "$stack_file" "$fixture_stack"
    docker -H "$manager_host" stack services "$fixture_stack"
    ;;
  compose-proxy)
    require_docker
    require_lab
    test "$compose_traefik_project" = "openship-compose-traefik-fixture" || {
      echo "Refusing unexpected Compose fixture" >&2
      exit 1
    }
    docker -H "$manager_host" compose -p "$compose_traefik_project" -f "$compose_traefik_file" up -d
    docker -H "$manager_host" compose -p "$compose_traefik_project" -f "$compose_traefik_file" ps
    ;;
  status)
    require_docker
    require_lab
    docker -H "$manager_host" stack services "$fixture_stack"
    docker -H "$manager_host" stack ps --no-trunc "$fixture_stack"
    ;;
  observe-proof)
    require_docker
    require_lab
    command -v bun >/dev/null 2>&1 || { echo "bun is required for the observe proof" >&2; exit 1; }
    event_file=$(mktemp "${TMPDIR:-/tmp}/openship-swarm-observe-events.XXXXXX")
    event_pid=""
    stop_events() {
      if [ -n "$event_pid" ]; then
        kill "$event_pid" >/dev/null 2>&1 || true
        wait "$event_pid" 2>/dev/null || true
      fi
    }
    trap stop_events EXIT INT TERM
    # Capture all workload-relevant resource classes on the nested manager.
    # The fixture must already be stable before this command is run.
    docker -H "$manager_host" events --since "$(date +%s)" --format '{{json .}}' >"$event_file" 2>&1 &
    event_pid=$!
    sleep 1
    # The harness imports the API's service factories. Supply an isolated,
    # disposable internal token solely to satisfy normal API configuration
    # validation; it is never sent to Docker or persisted.
    INTERNAL_TOKEN="openship-swarm-observe-proof-internal-token-0001" DOCKER_HOST="$manager_host" OPENSHIP_SWARM_FIXTURE_STACK="$fixture_stack" bun "$repo_root/scripts/swarm-observe-harness.ts"
    sleep 1
    stop_events
    event_pid=""
    trap - EXIT INT TERM
    # Swarm task lifecycle appears as Docker container events. A stable fixture
    # should produce no event at all for this sequence; fail closed on every
    # lifecycle action that changes a service/task/resource.
    mutations=$(grep -E '"Type":"(service|network|config|secret|volume|container)".*"Action":"(create|update|remove|destroy|start|stop|die|kill|restart|pause|unpause)"' "$event_file" || true)
    if [ -n "$mutations" ]; then
      echo "Observe-only proof detected Docker workload mutation events:" >&2
      echo "$mutations" >&2
      echo "Full event capture: $event_file" >&2
      exit 1
    fi
    echo "Observe-only proof passed: no service, task, network, config, secret, or volume mutation events."
    echo "Event capture: $event_file"
    ;;
  managed-proof)
    require_docker
    require_lab
    command -v bun >/dev/null 2>&1 || { echo "bun is required for the managed deploy proof" >&2; exit 1; }
    ensure_managed_persistent_objects
    INTERNAL_TOKEN="openship-swarm-managed-proof-internal-token-0001" DOCKER_HOST="$manager_host" OPENSHIP_SWARM_MANAGED_STACK="$managed_stack" bun "$repo_root/scripts/swarm-managed-deploy-harness.ts"
    ;;
  operations-proof)
    require_docker
    require_lab
    command -v bun >/dev/null 2>&1 || { echo "bun is required for the managed operations proof" >&2; exit 1; }
    INTERNAL_TOKEN="openship-swarm-managed-operations-proof-internal-token-0001" DOCKER_HOST="$manager_host" OPENSHIP_SWARM_MANAGED_STACK="$managed_stack" bun "$repo_root/scripts/swarm-managed-operations-harness.ts"
    ;;
  events)
    require_docker
    require_lab
    echo "Capturing fixture-only events for 30 seconds (Ctrl-C to stop early)."
    docker -H "$manager_host" events --filter 'label=com.openship.swarm.fixture=true'
    ;;
  cleanup)
    require_docker
    require_lab
    test "$fixture_stack" = "openship-swarm-fixture" || { echo "Refusing unexpected stack" >&2; exit 1; }
    test "$compose_traefik_project" = "openship-compose-traefik-fixture" || {
      echo "Refusing unexpected Compose fixture" >&2
      exit 1
    }
    docker -H "$manager_host" compose -p "$compose_traefik_project" -f "$compose_traefik_file" down --volumes --remove-orphans || true
    docker -H "$manager_host" stack rm "$fixture_stack"
    docker -H "$manager_host" stack rm "$managed_stack" || true
    wait_for_stack_removal "$fixture_stack"
    wait_for_stack_removal "$managed_stack"
    remove_managed_persistent_objects
    ;;
  down)
    require_docker
    test "$lab_project" = "openship-swarm-lab" || { echo "Refusing unexpected project" >&2; exit 1; }
    docker compose -p "$lab_project" -f "$compose_file" down --volumes --remove-orphans
    ;;
  *) usage ;;
esac
