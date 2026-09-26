; 예전 설치판은 서버 데이터를 설치 폴더의 data\ 에 두었다.
; 업데이트할 때 예전 제거 프로그램이 설치 폴더를 통째로 지우므로,
; 그 전에 data\ 를 설치 폴더 밖(%LOCALAPPDATA%\MCES\data)으로 옮긴다.
; 앱(src/main/paths.js)도 같은 위치를 쓴다.
!macro customInit
  Push $0
  Push $1
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $0 == ""
    ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${endif}
  ReadEnvStr $1 LOCALAPPDATA
  ${if} $0 != ""
  ${andIf} $1 != ""
  ${andIf} ${FileExists} "$0\data\servers\*.*"
  ${andIfNot} ${FileExists} "$1\MCES\data\servers\*.*"
    CreateDirectory "$1\MCES"
    ; 비어 있는 폴더만 지운다 (내용이 있으면 그대로 둔다)
    RMDir "$1\MCES\data"
    mcesMoveData:
    ClearErrors
    Rename "$0\data" "$1\MCES\data"
    ${if} ${Errors}
      ; 드라이브가 다르면 이름 바꾸기가 안 되므로 복사한다
      ClearErrors
      CreateDirectory "$1\MCES\data"
      CopyFiles /SILENT "$0\data\*.*" "$1\MCES\data"
      ${if} ${Errors}
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "서버 데이터를 옮기지 못했습니다.$\r$\nMCES와 실행 중인 서버를 모두 종료한 뒤 다시 시도를 누르세요.$\r$\n$\r$\n취소하면 아무것도 바꾸지 않고 설치를 멈춥니다." IDRETRY mcesMoveData
        Abort
      ${endif}
    ${endif}
  ${endif}
  Pop $1
  Pop $0
!macroend
