# 人間向けの入口。実装は npm scripts と scripts/ にある。
# CI は npm を直接叩くので、ここに実装を書かないこと。
.DEFAULT_GOAL := help
.PHONY: help setup test lint score new fingerprint

help: ## このヘルプを表示する
	@grep -hE '^[a-z-]+:.*?##' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

setup: ## 依存を入れる
	npm ci

test: ## 全ゲート (schema 検証 + ESLint + 単体テスト)
	npm test

lint: ## ESLint だけ実行する
	npm run lint

score: ## 採点して docs/scores.csv を更新する
	npm run score

new: ## 自治体の足場を作る (make new HANDLE=ogose-town)
	@test -n "$(HANDLE)" || { echo "usage: make new HANDLE=<handle> [PREF=<県>]"; exit 2; }
	npm run new -- --handle $(HANDLE) $(if $(PREF),--pref $(PREF))

fingerprint: ## 指紋を採る (外部取得あり。make fingerprint PREF=saitama HANDLES=a,b)
	@test -n "$(PREF)" || { echo "usage: make fingerprint PREF=<県> HANDLES=a,b"; exit 2; }
	npm run fingerprint -- --pref $(PREF) $(if $(HANDLES),--handles $(HANDLES)) $(if $(LIMIT),--limit $(LIMIT))
