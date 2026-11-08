import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// Unread mail from Mailroom, in the Omarchy bar.
//
// Mailroom writes ~/.local/state/mailroom/bar.json whenever its unread count
// changes: { "unread": 3, "app": "/path/to/mailroom" }. A left click opens
// Mailroom, a right click asks it to check for new mail.
//
// Settings > Omarchy in Mailroom installs and removes this plugin. Only
// components the Omarchy shell itself provides are used here (BarWidget,
// BarIconButton, WidgetButton, IpcHandler); an unknown type or property
// stops the whole widget loading, with nothing shown in the bar.
BarWidget {
  id: root
  moduleName: "blacksheep.mailroom"

  readonly property string stateFile:
    (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state")) + "/mailroom/bar.json"

  property int unread: 0
  property string app: ""

  // Nerd Font envelope: filled with unread mail, outlined without.
  readonly property string glyph: unread > 0 ? "\u{f01ee}" : "\u{f01f0}"
  readonly property bool showCount: unread > 0 && !vertical
  readonly property string tip: unread === 1 ? "1 unread message" : unread + " unread messages"

  function ingest(text) {
    var value = {}
    try { value = JSON.parse(text) || {} } catch (e) { value = {} }
    var count = Number(value.unread)
    root.unread = isFinite(count) && count > 0 ? Math.min(Math.floor(count), 99999) : 0
    root.app = typeof value.app === "string" && value.app.charAt(0) === "/" ? value.app : ""
  }

  function openMailroom() {
    if (root.app) Quickshell.execDetached(["uwsm-app", "--", root.app])
  }

  function checkMail() {
    if (root.app) Quickshell.execDetached([root.app, "--check-mail"])
  }

  function clicked(b) {
    if (b === Qt.RightButton) root.checkMail()
    else root.openMailroom()
  }

  // Hidden until Mailroom has run once and said where it lives.
  visible: root.app !== ""
  implicitWidth: root.showCount ? counted.implicitWidth : icon.implicitWidth
  implicitHeight: root.showCount ? counted.implicitHeight : icon.implicitHeight

  FileView {
    id: state
    path: root.stateFile
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.ingest(text())
    onLoadFailed: root.ingest("")
  }

  IpcHandler {
    target: "blacksheep.mailroom"

    function refresh(): void { state.reload() }
    function open(): void { root.openMailroom() }
  }

  // No unread mail, or a vertical bar: the envelope alone, like the other icons.
  BarIconButton {
    id: icon
    anchors.fill: parent
    visible: !root.showCount
    bar: root.bar
    text: root.glyph
    slotSize: Style.bar.statusSlot
    tooltipText: root.tip
    onPressed: function(b) { root.clicked(b) }
  }

  // Unread mail: the envelope and the count.
  WidgetButton {
    id: counted
    anchors.fill: parent
    visible: root.showCount
    bar: root.bar
    text: root.glyph + " " + root.unread
    tooltipText: root.tip
    onPressed: function(b) { root.clicked(b) }
  }
}
