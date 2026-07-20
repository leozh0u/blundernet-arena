# Local development ------------------------------------------------------

.PHONY: test build up down e2e loadtest deploy destroy

test:
	go vet ./...
	go test ./...

build:
	cd web && npm run build
	go build ./...

up:
	docker compose up -d --build

down:
	docker compose down

e2e:
	./scripts/e2e.sh

loadtest:
	k6 run loadtest/game_flow.js

# AWS deploy window -------------------------------------------------------
# Requires: aws cli with credentials, terraform, and TF_VAR_db_password.
# The stack costs real money while up; `make destroy` when done.

AWS_REGION ?= us-east-1
TF = terraform -chdir=deploy/terraform

deploy:
	$(TF) init
	$(TF) apply -auto-approve
	$(eval ECR_API := $(shell $(TF) output -raw ecr_api))
	$(eval ECR_WORKER := $(shell $(TF) output -raw ecr_worker))
	aws ecr get-login-password --region $(AWS_REGION) | \
		docker login --username AWS --password-stdin $(shell echo $(ECR_API) | cut -d/ -f1)
	docker build --platform linux/amd64 --target api -t $(ECR_API):latest .
	docker build --platform linux/amd64 --target worker -t $(ECR_WORKER):latest .
	docker push $(ECR_API):latest
	docker push $(ECR_WORKER):latest
	aws ecs update-service --region $(AWS_REGION) --cluster arena --service api --force-new-deployment > /dev/null
	aws ecs update-service --region $(AWS_REGION) --cluster arena --service worker --force-new-deployment > /dev/null
	@echo "live at: $$($(TF) output -raw url)"

destroy:
	$(TF) destroy -auto-approve
