#!/usr/bin/env bash
# 조회 API를 띄운다. .env를 읽어 환경변수로 넘기는 일까지 여기서 한다.
#
#   ./run-api.sh
#
# docker compose는 .env를 자동으로 읽지만 mvn/java는 읽지 않는다.
# 매번 `set -a; source .env; set +a`를 치는 대신 이 스크립트를 쓴다.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
    echo ".env가 없습니다. 먼저 만들어 주세요:" >&2
    echo "  cp .env.example .env    # 그리고 PG_PASSWORD, MONGO_PASSWORD를 채운다" >&2
    exit 1
fi
set -a; source .env; set +a

# Maven을 찾는다. 설치돼 있으면 그걸 쓰고, 없으면 임시로 받아 둔 것을 쓴다.
if command -v mvn >/dev/null 2>&1; then
    MVN=mvn
elif [ -x /tmp/apache-maven-3.9.9/bin/mvn ]; then
    MVN=/tmp/apache-maven-3.9.9/bin/mvn
    export MAVEN_OPTS="${MAVEN_OPTS:-}"
    set -- -Dmaven.repo.local=/tmp/kamogis-m2 "$@"
    echo "note: mvn이 PATH에 없어 /tmp의 Maven을 씁니다. 재부팅하면 사라집니다 — 'brew install maven' 권장." >&2
else
    echo "Maven을 찾을 수 없습니다. 'brew install maven' 후 다시 실행하세요." >&2
    exit 1
fi

if ! docker compose ps --status running --quiet postgres 2>/dev/null | grep -q .; then
    echo "note: postgres 컨테이너가 안 떠 있습니다. 'docker compose up -d' 먼저 실행하세요." >&2
fi

echo "API → http://127.0.0.1:${API_PORT:-58080}   (Ctrl+C로 종료)"
exec "$MVN" -q -f backend/pom.xml "$@" compile exec:java -Dexec.mainClass=kr.kamogis.ApiServer
