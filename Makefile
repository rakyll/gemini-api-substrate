# Gemini API 🤝 Agent Substrate — demo helpers.
#
#   make demo     build and start the demo UI on http://127.0.0.1:8765
#   make status   show controller, WorkerPool pods and Substrate actors
#   make logs     follow the gemini-substrate-controller logs
#   make reset    delete all demo actors (asks for confirmation)
#   make fix-router  restart atenet-router if it has no ready endpoints
#                    (symptom: StartWork ... connect: connection refused)

CTX       ?= kind-gemini-api
NAMESPACE ?= gemini-self-hosted
ATESPACE  ?= gemini-self-hosted
ADDR      ?= 127.0.0.1:8765
ATE_SYSTEM ?= ate-system

.DEFAULT_GOAL := help
.PHONY: help demo build open status logs reset fix-router clean

help: ## Show available targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-11s\033[0m %s\n", $$1, $$2}'

demo: ## Build and start the demo UI (needs GEMINI_API_KEY)
	@test -n "$$GEMINI_API_KEY" || { echo "GEMINI_API_KEY must be set"; exit 1; }
	@echo "Starting demo on http://$(ADDR) (context=$(CTX))"
	cd demo && go build -o substrate-demo . && ./substrate-demo -addr=$(ADDR) -context=$(CTX) -namespace=$(NAMESPACE) -atespace=$(ATESPACE)

build: ## Build the demo binary only
	cd demo && go build -o substrate-demo .

open: ## Open the demo UI in the browser
	open http://$(ADDR)

status: ## Show controller, WorkerPool pods and actors
	@kubectl --context $(CTX) get deploy,workerpool,pods -n $(NAMESPACE)
	@echo
	@kubectl ate --context $(CTX) get actors -a $(ATESPACE) 2>/dev/null

logs: ## Follow the controller logs
	kubectl --context $(CTX) logs -f deploy/gemini-substrate-controller -n $(NAMESPACE)

reset: ## Delete all demo actors (asks for confirmation)
	CTX=$(CTX) ATESPACE=$(ATESPACE) ./demo/reset.sh

# atenet-router can get stuck after a liveness restart under load: the pod
# stays 1/2 ready (envoy dataplane health returns 503), the Service has no
# endpoints, and StartWork fails with "connection refused". It is stateless,
# so a rollout restart is safe. No-op when the router already has endpoints.
fix-router: ## Restart atenet-router if it has no ready endpoints (FORCE=1 to always)
	@eps=$$(kubectl --context $(CTX) get endpointslices -n $(ATE_SYSTEM) \
	    -l kubernetes.io/service-name=atenet-router \
	    -o jsonpath='{.items[*].endpoints[?(@.conditions.ready==true)].addresses[*]}') || exit 1; \
	if [ -n "$$eps" ] && [ -z "$(FORCE)" ]; then \
	  echo "atenet-router is healthy (ready: $$eps); nothing to do. Use FORCE=1 to restart anyway."; \
	  exit 0; \
	fi; \
	echo "Restarting atenet-router (ready endpoints: $${eps:-none})..."; \
	kubectl --context $(CTX) rollout restart deploy/atenet-router -n $(ATE_SYSTEM) && \
	kubectl --context $(CTX) rollout status deploy/atenet-router -n $(ATE_SYSTEM) --timeout=180s && \
	kubectl --context $(CTX) get pods -n $(ATE_SYSTEM) -l app=atenet-router

clean: ## Remove the built demo binary
	rm -f demo/substrate-demo
