#!/bin/sh
# Disposable Docker Swarm lab. It creates only the fixed openship-swarm-lab
# Compose project, a nested ordinary Compose Traefik fixture, and the
# openship-swarm-fixture stack; cleanup refuses every other target. See
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
manager_host="tcp://127.0.0.1:23750"

usage() {
  echo "Usage: scripts/swarm-lab.sh {up|deploy|compose-proxy|status|events|cleanup|down}" >&2
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
    ;;
  down)
    require_docker
    test "$lab_project" = "openship-swarm-lab" || { echo "Refusing unexpected project" >&2; exit 1; }
    docker compose -p "$lab_project" -f "$compose_file" down --volumes --remove-orphans
    ;;
  *) usage ;;
esac
