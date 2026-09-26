# MC Easy Server

친구들끼리 마인크래프트 서버를 여는 데 필요한 일을 한 앱에서 처리합니다.
플러그인 서버(Paper), 모드 서버(Fabric), 바닐라 서버를 만들 수 있고, Java 준비, 최적화, 친구 접속 주소, 플러그인·모드 설치, 백업까지 앱이 맡습니다.

설치 마법사처럼 단계를 넘기는 방식이 아닙니다. Docker Desktop처럼 **한 화면**에서 서버를 추가·삭제·관리합니다. 왼쪽에 서버 목록이 있고, 오른쪽에서 고른 서버를 다룹니다.

## 실행

```bash
npm install
npm start          # 개발 실행
npm test           # 테스트
npm run dist:win   # Windows 설치 파일 + 포터블 exe (dist/)
```

## 데이터 위치

서버, Java 런타임, 백업, 터널 프로그램은 모두 **앱 폴더 안**에 만들어집니다. 시스템에는 아무것도 설치하지 않습니다.

| 실행 방식 | 위치 |
| --- | --- |
| 개발(`npm start`) | `./data` |
| 설치판 | 실행 파일 옆 `data/` |
| 포터블 exe | exe 옆 `MCEasyData/` |

```
data/
  servers/<id>/      서버 폴더 (server.jar, world, plugins|mods …)
  runtimes/java-21/  앱이 받은 Java (Adoptium Temurin JRE)
  backups/<id>/      월드 백업 zip
  tools/playit/      playit.gg 에이전트
  servers.json       서버 목록·설정
```

## 기능

### 서버를 만들기 전에 확인하는 것
- **Java 자동 감지·설치**: 고른 마크 버전에 필요한 Java 버전을 Mojang 메타데이터로 확인합니다(1.20.5 이상은 Java 21, 1.18~1.20.4는 17 등). 필요한 Java가 없으면 Adoptium에서 받아 `runtimes/`에 풉니다.
- **PC 사양 확인**: 전체 RAM을 읽어 서버 메모리를 추천합니다(예: 16GB → 6GB). 슬라이더에도 추천값이 표시됩니다.

### 서버를 만들 때
1. 종류 선택: 플러그인 서버(Paper), 모드 서버(Fabric), 바닐라 서버
2. 버전 선택: 기본값은 최신 안정 버전
3. 기본 설정: `server.properties`를 직접 보여주지 않고 난이도, 게임 모드, 최대 인원, PVP, 화이트리스트 등을 풀어서 설명합니다
4. EULA 동의: 한 줄 설명과 체크박스
5. 최적화 자동 적용
   - Aikar's flags(G1GC JVM 옵션). 12GB 이상이면 큰 힙용 값을 씁니다
   - `server.properties`: 할당 메모리에 맞춘 view-distance와 simulation-distance, network-compression-threshold
   - Paper: `paper-world-defaults.yml`, `spigot.yml`, `bukkit.yml`에 추천값을 넣습니다. 이 파일들은 첫 실행 때 생기므로, 생긴 뒤 주석을 유지한 채 값만 바꿉니다
   - Fabric: Fabric API, Lithium, FerriteCore를 함께 설치합니다

### 서버를 운영할 때
6. **터널 자동 연결**: 서버가 켜지면 앱이 playit.gg 에이전트를 내부에서 실행하고, 받아온 접속 주소를 상단에 **복사 버튼**과 함께 표시합니다. 첫 실행 때는 브라우저에서 한 번 승인해야 합니다. 포트포워딩이 되는 환경이라면 설정 탭의 **UPnP 포트 열기**를 대신 쓸 수 있습니다.
7. **접속 상태 확인**: 두 가지를 점검해 초록/빨강으로 보여줍니다. "서버 응답"은 로컬 Server List Ping, "외부 접속"은 mcsrvstat.us 외부 점검입니다.
8. **Modrinth 검색·원클릭 설치**: 현재 서버 종류와 버전에 맞는 것만 보여줍니다. Paper는 paper/spigot/bukkit 플러그인, Fabric은 서버에서 도는 모드, 바닐라는 데이터팩입니다.
9. **의존성 자동 설치**: 필수(required) 의존성을 재귀적으로 함께 설치합니다. Fabric 서버라면 **친구용 모드팩(.mrpack)을 내보낼 수 있습니다.** 클라이언트에서 쓸 수 없는 서버 전용 모드는 빠집니다.
10. 켜기/끄기/다시 켜기, 삭제, 업데이트 버튼
11. **접속자 목록**: 클릭으로 강퇴, OP, 화이트리스트 추가, 차단을 할 수 있습니다
12. **성능 표시**: TPS 게이지와 메모리 사용량 그래프. Paper는 `tps` 명령, 1.20.3 이상의 바닐라/Fabric은 `tick query`의 평균 틱 시간으로 TPS를 구합니다
13. **자동 백업**: 정해진 간격마다, 그리고 서버를 끌 때 월드를 백업합니다. 백업 중에는 `save-off` → `save-all flush` → zip → `save-on` 순서로 진행합니다. 복원 버튼을 누르면 지금 월드를 "복원 전" 백업으로 먼저 남깁니다
14. **안전한 종료**: 창을 닫아도 서버를 강제 종료하지 않습니다. `stop`으로 저장한 뒤 정지하고 앱을 닫습니다
15. **오류를 쉬운 말로 번역**: 포트 사용 중, 메모리 부족·과다 할당, Java 버전 불일치, 버전이 맞지 않는 플러그인, 빠진 의존성, Fabric 모드 충돌을 잡아냅니다. "이 플러그인이 현재 버전과 맞지 않아요 → 비활성화할까요?"처럼 해결 버튼과 함께 안내합니다
16. **업데이트 시 호환성 경고**: 버전을 올리기 전에 Modrinth에서 새 버전에 맞는 파일이 없는 플러그인·모드를 알려줍니다. 업데이트하면 맞는 것은 새 파일로 바꾸고, 안 맞는 것은 꺼 둡니다. 업데이트 전에 월드를 자동으로 백업합니다

## 디자인

`design/`의 "형태 없는 결" 토큰(`tokens.css`)과 레시피(`RECIPES.md`)를 따릅니다.
- 테두리 없이 단차(올라옴/내려감)로 영역을 가릅니다
- 모든 글자에 농도 그라디언트를 줍니다
- 그래프는 능선 4겹(면 → 그늘 → 빛 → 선), TPS는 3겹 홈 위의 발광 원호로 그립니다
- 다크/라이트 테마를 모두 지원합니다

요구사항의 "초록/빨강" 접속 상태 표시를 위해 같은 결로 `--ok`/`--bad` 색만 추가했습니다(`src/renderer/styles.css`).

## 구조

```
src/main/
  main.js            Electron 창, IPC, 안전한 종료
  server-manager.js  생성·실행·정지·업데이트, 로그 파싱(접속자/TPS), 자동 백업
  java.js            Java 감지·설치 (Adoptium)
  versions.js        Paper(Fill v3, v2 대체) / Fabric meta / Mojang 버전·jar
  optimize.js        Aikar's flags, Paper/Spigot/Bukkit 최적값
  modrinth.js        검색·설치·의존성·호환성·mrpack
  tunnel.js          playit.gg 에이전트
  upnp.js            UPnP(IGD) 포트 매핑
  reachability.js    Server List Ping, 외부 점검, 빈 포트 찾기
  errors.js          로그 → 쉬운 말 안내
  backup.js          월드 zip 백업·복원
src/renderer/        화면 (프레임워크 없이 순수 JS)
test/                node:test 테스트 (가짜 서버 프로세스로 실행/정지 흐름 검증)
```

## 알아둘 점
- playit.gg CLI의 출력 형식은 버전에 따라 달라질 수 있습니다. 주소를 자동으로 찾지 못하면 주소 줄의 ✎ 버튼으로 playit.gg 대시보드의 주소를 직접 입력하세요. 터널의 로컬 포트가 서버 포트와 다르면 앱이 알려줍니다.
- 외부 접속 점검은 공개 서비스(mcsrvstat.us)를 쓰므로 결과가 1~2분 늦을 수 있습니다.
- 앱 밖에서 직접 넣은 플러그인·모드 jar도 목록에 보이고 켜고 끌 수 있습니다. 다만 업데이트 호환성 검사는 Modrinth로 설치한 것만 가능합니다.
