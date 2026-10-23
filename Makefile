# 人間向けの入口。実装は npm scripts と scripts/ にある。
# CI は npm を直接叩くので、ここに実装を書かないこと。
.DEFAULT_GOAL := help
.PHONY: help setup test lint

help: ## このヘルプを表示する
	@grep -hE '^[a-z-]+:.*?##' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

setup: ## 依存を入れる
	npm ci

test: ## 全ゲート (schema 検証 + ESLint + 単体テスト)
	npm test

lint: ## ESLint だけ実行する
	npm run lint
