# Gemini API 🤝 Agent Substrate — demo helpers.
#
#   make demo     build and start the demo UI on http://127.0.0.1:8765
#   make status   show controller, WorkerPool pods and Substrate actors
#   make logs     follow the gemini-substrate-controller logs
#   make reset    delete all demo actors (asks for confirmation)

CTX       ?= kind-gemini-api
NAMESPACE ?= gemini-self-hosted
ATESPACE  ?= gemini-self-hosted
ADDR      ?= 127.0.0.1:8765

.DEFAULT_GOAL := help
.PHONY: help demo build open status logs reset clean

help: ## Show available targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-8s\033[0m %s\n", $$1, $$2}'

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

clean: ## Remove the built demo binary
	rm -f demo/substrate-demo
