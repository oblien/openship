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
registry_service="openship-swarm-lab-registry"
registry_proof_service="openship-swarm-registry-proof"
registry_proof_image="openship-swarm-registry-proof:build"
registry_auth_secret="openship_lab_registry_auth"
registry_test_username="openship-lab"
registry_test_password="registry-proof-only"
edge_service="openship-swarm-edge-proof"
edge_backend_service="openship-swarm-edge-backend"
edge_network="openship-swarm-edge-proof-net"
edge_config="openship-swarm-edge-proof-site"
edge_route_update_config="openship-swarm-edge-route-update-proof"
edge_sites_volume="openship-swarm-edge-proof-sites"
edge_certs_volume="openship-swarm-edge-proof-certs"
edge_acme_volume="openship-swarm-edge-proof-acme"
edge_image="${OPENSHIP_EDGE_IMAGE:-ghcr.io/oblien/openship-edge:latest}"
manager_host="tcp://127.0.0.1:23750"

usage() {
  echo "Usage: scripts/swarm-lab.sh {up|deploy|compose-proxy|status|observe-proof|managed-proof|operations-proof|registry-proof|edge-proof|events|cleanup|down}" >&2
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

wait_for_service_removal() {
  service_name="$1"
  attempts=0
  while docker -H "$manager_host" service inspect "$service_name" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 30 ]; then
      echo "Timed out waiting for disposable service $service_name to be removed" >&2
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

manager_node_address() {
  docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$manager"
}

ensure_lab_registry() {
  if docker -H "$manager_host" service inspect "$registry_service" >/dev/null 2>&1; then
    return
  fi
  if ! docker -H "$manager_host" secret inspect "$registry_auth_secret" >/dev/null 2>&1; then
    # A disposable fixed credential proves Docker's Swarm auth propagation. It
    # is created as a Swarm secret, never printed, and removed by cleanup.
    docker -H "$manager_host" run --rm --entrypoint htpasswd httpd:2.4-alpine -Bbn "$registry_test_username" "$registry_test_password" | \
      docker -H "$manager_host" secret create "$registry_auth_secret" - >/dev/null
  fi
  docker -H "$manager_host" service create \
    --name "$registry_service" \
    --constraint 'node.role == manager' \
    --publish published=5000,target=5000,protocol=tcp,mode=host \
    --secret source="$registry_auth_secret",target=htpasswd \
    --env REGISTRY_AUTH=htpasswd \
    --env 'REGISTRY_AUTH_HTPASSWD_REALM=OpenShip Swarm lab' \
    --env REGISTRY_AUTH_HTPASSWD_PATH=/run/secrets/htpasswd \
    registry:2 >/dev/null
  attempts=0
  until docker -H "$manager_host" service ps --filter desired-state=running --format '{{.CurrentState}}' "$registry_service" | grep -q '^Running'; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 45 ]; then
      echo "Nested lab registry did not become ready" >&2
      exit 1
    fi
    sleep 1
  done
}

remove_lab_registry_objects() {
  docker -H "$manager_host" service rm "$registry_proof_service" >/dev/null 2>&1 || true
  docker -H "$manager_host" service rm "$registry_service" >/dev/null 2>&1 || true
  docker -H "$manager_host" image rm "$registry_proof_image" >/dev/null 2>&1 || true
  docker -H "$manager_host" secret rm "$registry_auth_secret" >/dev/null 2>&1 || true
}

remove_edge_proof_objects() {
  docker -H "$manager_host" service rm "$edge_service" >/dev/null 2>&1 || true
  docker -H "$manager_host" service rm "$edge_backend_service" >/dev/null 2>&1 || true
  wait_for_service_removal "$edge_service"
  wait_for_service_removal "$edge_backend_service"
  docker -H "$manager_host" config rm "$edge_config" "$edge_route_update_config" >/dev/null 2>&1 || true
  docker -H "$manager_host" network rm "$edge_network" >/dev/null 2>&1 || true
  docker -H "$manager_host" volume rm "$edge_sites_volume" "$edge_certs_volume" "$edge_acme_volume" >/dev/null 2>&1 || true
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
  ensure_lab_registry
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
  registry-proof)
    require_docker
    require_lab
    ensure_lab_registry
    registry_address="$(manager_node_address):5000"
    test -n "$registry_address" || { echo "Could not resolve nested registry address" >&2; exit 1; }
    target="$registry_address/openship/registry-proof:deployment-1"
    registry_auth_dir=$(mktemp -d "${TMPDIR:-/tmp}/openship-swarm-registry-auth.XXXXXX")
    cleanup_registry_auth() {
      rm -f "$registry_auth_dir/config.json" || true
      rmdir "$registry_auth_dir" || true
    }
    trap cleanup_registry_auth EXIT INT TERM
    chmod 700 "$registry_auth_dir"
    registry_auth=$(printf '%s:%s' "$registry_test_username" "$registry_test_password" | base64 | tr -d '\n')
    printf '{"auths":{"%s":{"auth":"%s"}}}\n' "$registry_address" "$registry_auth" >"$registry_auth_dir/config.json"
    # Build only on the manager daemon, publish under a deterministic tag, and
    # deploy the digest to an explicitly worker-constrained service. The worker
    # has no pre-existing login and must pull from the manager-published registry.
    printf '%s\n' 'FROM busybox:1.36' 'CMD ["sh", "-c", "echo registry-proof; sleep 3600"]' | docker -H "$manager_host" build -t "$registry_proof_image" - >/dev/null
    docker -H "$manager_host" tag "$registry_proof_image" "$target"
    DOCKER_CONFIG="$registry_auth_dir" docker -H "$manager_host" image push "$target" >/dev/null
    digest="$(docker -H "$manager_host" image inspect --format '{{index .RepoDigests 0}}' "$target")"
    case "$digest" in
      "$registry_address"/*@sha256:*) ;;
      *) echo "Registry push did not produce an immutable digest" >&2; exit 1 ;;
    esac
    docker -H "$manager_host" service rm "$registry_proof_service" >/dev/null 2>&1 || true
    worker_hostname="$(docker exec "$worker" hostname)"
    DOCKER_CONFIG="$registry_auth_dir" docker -H "$manager_host" service create \
      --name "$registry_proof_service" \
      --constraint "node.hostname == $worker_hostname" \
      --with-registry-auth \
      "$digest" >/dev/null
    attempts=0
    until docker -H "$manager_host" service ps --no-trunc --format '{{.Node}} {{.CurrentState}} {{.Image}}' "$registry_proof_service" | grep -q "^$worker_hostname Running .*@sha256:"; do
      attempts=$((attempts + 1))
      if [ "$attempts" -ge 45 ]; then
        docker -H "$manager_host" service ps --no-trunc "$registry_proof_service" >&2 || true
        echo "Worker did not pull and run the digest-pinned registry image" >&2
        exit 1
      fi
      sleep 1
    done
    echo "Registry proof passed: worker pulled and ran $digest"
    cleanup_registry_auth
    trap - EXIT INT TERM
    ;;
  edge-proof)
    require_docker
    require_lab
    # The proof intentionally runs without the fixture stack: its Traefik
    # service owns port 80, exactly the external-router state that production
    # Edge enablement must refuse rather than take over.
    if docker -H "$manager_host" service ls --format '{{.Name}} {{.Ports}}' | grep -Eq '(^|_)swarm-traefik .*:(80|443)->'; then
      echo "Edge proof requires the fixture router to be absent; run cleanup first." >&2
      exit 1
    fi
    remove_edge_proof_objects
    manager_hostname="$(docker exec "$manager" hostname)"
    worker_hostname="$(docker exec "$worker" hostname)"
    docker -H "$manager_host" node update --label-add openship.edge.ingress=true "$manager_hostname" >/dev/null
    docker -H "$manager_host" network create --driver overlay --attachable=false \
      --label com.openship.edge.network=true --label com.openship.managed=true "$edge_network" >/dev/null
    docker -H "$manager_host" service create --name "$edge_backend_service" \
      --constraint "node.hostname == $worker_hostname" --network "$edge_network" nginx:1.27-alpine >/dev/null
    attempts=0
    until docker -H "$manager_host" service ps --format '{{.Node}} {{.CurrentState}}' "$edge_backend_service" | grep -q "^$worker_hostname Running"; do
      attempts=$((attempts + 1))
      [ "$attempts" -lt 45 ] || { echo "Edge backend did not run on the worker" >&2; exit 1; }
      sleep 1
    done
    # Swarm configs are immutable data and cause a task replacement on change;
    # this is the task-safe configuration transport, not a manager docker exec.
    printf '%s\n' \
      'server {' \
      '    listen 80;' \
      '    server_name edge-proof.invalid;' \
      '    location / {' \
      "        proxy_pass http://$edge_backend_service:80;" \
      '        proxy_set_header Host $host;' \
      '    }' \
      '}' | docker -H "$manager_host" config create "$edge_config" - >/dev/null
    docker -H "$manager_host" service create --name "$edge_service" --replicas 1 \
      --constraint 'node.labels.openship.edge.ingress == true' \
      --publish published=80,target=80,protocol=tcp,mode=host \
      --publish published=443,target=443,protocol=tcp,mode=host \
      --network "$edge_network" \
      --label com.openship.edge=swarm --label com.openship.managed=true \
      --mount "type=volume,source=$edge_sites_volume,target=/usr/local/openresty/nginx/conf/sites-enabled" \
      --mount "type=volume,source=$edge_certs_volume,target=/etc/letsencrypt" \
      --mount "type=volume,source=$edge_acme_volume,target=/var/www/acme" \
      --config "source=$edge_config,target=/usr/local/openresty/nginx/conf/sites-enabled/edge-proof.conf" \
      "$edge_image" >/dev/null
    attempts=0
    until docker -H "$manager_host" service ps --format '{{.Node}} {{.CurrentState}}' "$edge_service" | grep -q "^$manager_hostname Running"; do
      attempts=$((attempts + 1))
      [ "$attempts" -lt 60 ] || { docker -H "$manager_host" service ps --no-trunc "$edge_service" >&2 || true; echo "OpenShip Edge did not become ready" >&2; exit 1; }
      sleep 1
    done
    edge_container="$(docker -H "$manager_host" ps -q --filter "label=com.docker.swarm.service.name=$edge_service")"
    test -n "$edge_container" || { echo "Could not find the current Edge task container" >&2; exit 1; }
    docker -H "$manager_host" exec "$edge_container" sh -c 'touch /etc/letsencrypt/.openship-edge-proof-state'
    docker -H "$manager_host" exec "$edge_container" curl -fsS -H 'Host: edge-proof.invalid' http://127.0.0.1/ | grep -q 'Welcome to nginx!'
    docker -H "$manager_host" service update --force --detach=false "$edge_service" >/dev/null
    attempts=0
    while :; do
      replacement="$(docker -H "$manager_host" ps -q --filter "label=com.docker.swarm.service.name=$edge_service")"
      if [ -n "$replacement" ] && [ "$replacement" != "$edge_container" ] && docker -H "$manager_host" exec "$replacement" sh -c 'test -f /etc/letsencrypt/.openship-edge-proof-state' >/dev/null 2>&1; then
        break
      fi
      attempts=$((attempts + 1))
      [ "$attempts" -lt 60 ] || { docker -H "$manager_host" service ps --no-trunc "$edge_service" >&2 || true; echo "Edge replacement did not retain certificate state" >&2; exit 1; }
      sleep 1
    done
    docker -H "$manager_host" exec "$replacement" curl -fsS -H 'Host: edge-proof.invalid' http://127.0.0.1/ | grep -q 'Welcome to nginx!'
    # A real route mutation uses an immutable Docker config plus `service update`.
    # This must work after a task replacement without locating or execing a task.
    printf '%s\n' \
      'server {' \
      '    listen 80;' \
      '    server_name edge-route-proof.invalid;' \
      '    location /.well-known/acme-challenge/ {' \
      '        root /var/www/acme;' \
      '    }' \
      '    location / {' \
      "        proxy_pass http://$edge_backend_service:80;" \
      '        proxy_set_header Host $host;' \
      '    }' \
      '}' | docker -H "$manager_host" config create "$edge_route_update_config" - >/dev/null
    docker -H "$manager_host" service update --detach=false \
      --config-add "source=$edge_route_update_config,target=/usr/local/openresty/nginx/conf/sites-enabled/edge-route-proof.conf" \
      "$edge_service" >/dev/null
    updated_edge_container="$(docker -H "$manager_host" ps -q --filter "label=com.docker.swarm.service.name=$edge_service")"
    test -n "$updated_edge_container" || { echo "Edge route update produced no current task" >&2; exit 1; }
    docker -H "$manager_host" exec "$updated_edge_container" curl -fsS -H 'Host: edge-route-proof.invalid' http://127.0.0.1/ | grep -q 'Welcome to nginx!'
    docker -H "$manager_host" service inspect "$edge_service" --format '{{json .Spec.TaskTemplate.ContainerSpec.Configs}}' | grep -q 'edge-route-proof.conf'
    echo "Edge proof passed: the labelled Edge reached a worker service, retained state after replacement, and accepted a task-safe immutable route config update."
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
    remove_lab_registry_objects
    remove_edge_proof_objects
    ;;
  down)
    require_docker
    test "$lab_project" = "openship-swarm-lab" || { echo "Refusing unexpected project" >&2; exit 1; }
    docker compose -p "$lab_project" -f "$compose_file" down --volumes --remove-orphans
    ;;
  *) usage ;;
esac
