#!/bin/sh
# MCES 힙 측정 에이전트 빌드 (JDK 필요). 결과: src/main/assets/mces-agent.jar
set -e
cd "$(dirname "$0")"
rm -rf out && mkdir -p out
javac --release 8 -d out src/mces/HeapAgent.java
printf 'Premain-Class: mces.HeapAgent\nAgent-Class: mces.HeapAgent\n' > out/MANIFEST.MF
mkdir -p ../src/main/assets
jar cfm ../src/main/assets/mces-agent.jar out/MANIFEST.MF -C out mces
rm -rf out
