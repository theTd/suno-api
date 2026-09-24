#!/usr/bin/env bash
# scripts/check-env.sh — 部署前自检：确认 .env 值经 docker compose 注入后不被插值改写。
#
# 背景：compose 解析 .env 时做变量插值，值里的 $片段会被替换为空字符串
# （@next/env 同理且单引号无效，详见 .env.example 顶部注释与 CLAUDE.md
# 「Env value interpolation gotcha」）。本脚本做三道检查：
#   [1/3] docker compose config 的 stderr 必须 0 条 "variable is not set"
#         与 0 条 obsolete 警告；
#   [2/3] 最小 compose 探针：临时 alpine 容器按 env_file 注入 .env，容器内
#         SUNO_COOKIE / TWOCAPTCHA_KEY 的长度与 sha256 必须与宿主字面解析
#         逐字节一致；
#   [3/3] 镜像零秘密断言（传镜像名时）：`docker history --no-trunc` 与
#         `docker inspect .Config.Env` 中 SUNO_COOKIE 的提及计数必须为 0
#         （按名断言看不到「值被改名/值写进层文件」类泄漏）。镜像必须存在、
#         且镜像名不得为空或以 `-` 开头，否则直接 FAIL（fail-closed，防止不存在/
#         拼错的镜像被误判为干净；docker 命令执行异常同样直接 FAIL，不会把
#         空输出误计为 0 处提及）。
#
# 用法：bash scripts/check-env.sh [镜像名]    （需要 docker；首次运行会拉取 alpine）
set -euo pipefail

cd "$(dirname "$0")/.."

fail=0

echo "[1/3] docker compose config 警告检查 ..."
# fail-closed：docker compose config 本身失败（compose 文件解析/语法损坏）时
# 直接 FAIL，不把失败输出误计为 0 条警告；grep -c 无匹配（输出 0、退出码 1）
# 属正常情况，用 `|| :` 只兜住 grep 自身。
if stderr_out=$(docker compose config 2>&1 >/dev/null); then
  var_warn=$(printf '%s\n' "$stderr_out" | grep -c 'variable is not set' || :)
  obs_warn=$(printf '%s\n' "$stderr_out" | grep -ci 'obsolete' || :)
  if [ "$var_warn" -ne 0 ]; then
    echo "FAIL: ${var_warn} 条 variable-is-not-set 警告 —— .env 值正被插值改写（含 \$ 的值请剔除 \$ 片段，或用单引号包裹）" >&2
    fail=1
  else
    echo "  OK: 0 条 variable-is-not-set"
  fi
  if [ "$obs_warn" -ne 0 ]; then
    echo "FAIL: ${obs_warn} 条 obsolete 警告 —— 检查 docker-compose.yml 的 version 字段" >&2
    fail=1
  else
    echo "  OK: 0 条 obsolete"
  fi
else
  echo "FAIL: docker compose config 执行失败，无法断言 0 插值警告" >&2
  fail=1
fi

echo "[2/3] 容器注入值逐字节比对（SUNO_COOKIE / TWOCAPTCHA_KEY）..."
probe_dir=$(mktemp -d)
trap 'rm -rf "$probe_dir"' EXIT
cp .env "$probe_dir/.env"
cat > "$probe_dir/docker-compose.yml" <<'YAML'
name: env-probe
services:
  probe:
    image: alpine
    env_file: ".env"
YAML

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  else
    shasum -a 256 | cut -d' ' -f1
  fi
}

# 宿主侧字面解析 .env：剥掉行尾 CR 与包裹值的单引号，不做任何插值。
literal_value() {
  sed -n "s/^$1=//p" .env | head -1 | sed "s/\r$//; s/^'//; s/'$//"
}

check_var() {
  local key=$1 expected got exp_sha got_sha
  expected=$(literal_value "$key")
  got=$( (cd "$probe_dir" && docker compose run --rm --no-deps probe sh -c "printf %s \"\$$key\"") 2>/dev/null )
  exp_sha=$(printf %s "$expected" | sha256)
  got_sha=$(printf %s "$got" | sha256)
  if [ "${#expected}" -eq "${#got}" ] && [ "$exp_sha" = "$got_sha" ]; then
    echo "  OK: $key 一致（len=${#got}）"
  else
    echo "FAIL: $key 被改写（宿主 len=${#expected} sha=$exp_sha vs 容器 len=${#got} sha=$got_sha）" >&2
    fail=1
  fi
}

check_var SUNO_COOKIE
check_var TWOCAPTCHA_KEY

if [ "$#" -ge 1 ]; then
  img=$1
  echo "[3/3] 镜像零秘密断言（$img）..."
  # fail-closed：镜像必须真实存在，且镜像名不得以 `-` 开头（防止被当成 docker 旗标）。
  if [ -z "$img" ] || [ "${img#-}" != "$img" ]; then
    echo "FAIL: 非法镜像名: [$img]" >&2
    fail=1
  elif ! docker image inspect "$img" >/dev/null 2>&1; then
    echo "FAIL: 镜像不存在: $img" >&2
    fail=1
  else
    # fail-closed：history / inspect --format 任一 docker 命令异常都直接 FAIL，
    # 不把「命令失败产生的空输出」误计为 0 处提及；grep -c 无匹配（输出 0、退出码 1）
    # 属正常情况，用 `|| :` 只兜住 grep 自身。
    if hist_out=$(docker history --no-trunc "$img") && env_out=$(docker inspect --format '{{json .Config.Env}}' "$img"); then
      hist_hits=$(printf '%s' "$hist_out" | grep -c 'SUNO_COOKIE' || :)
      env_hits=$(printf '%s' "$env_out" | grep -c 'SUNO_COOKIE' || :)
      if [ "$hist_hits" -ne 0 ] || [ "$env_hits" -ne 0 ]; then
        echo "FAIL: 镜像元数据残留 SUNO_COOKIE（history=${hist_hits} 处、Config.Env=${env_hits} 处）" >&2
        fail=1
      else
        echo "  OK: history / Config.Env 均 0 处提及 SUNO_COOKIE"
      fi
    else
      echo "FAIL: docker history/inspect 执行失败: $img（无法断言镜像零秘密）" >&2
      fail=1
    fi
  fi
else
  echo "[3/3] SKIP: 未传镜像名（用法：bash scripts/check-env.sh <image>）"
fi

if [ "$fail" -ne 0 ]; then
  echo "check-env: FAILED" >&2
  exit 1
fi
echo "check-env: PASSED"
