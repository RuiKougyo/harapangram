// Supabase の「Project Settings → API」にある2つを貼ってください。
// anon key は公開して大丈夫なキーです（守りはデータベースのアクセス制限が担当）。
// service_role key は絶対にここに書かないでください。
window.HP_CONFIG = {
  url: "https://tgabyfbrxnwptmesgodb.supabase.co",
  anonKey: "sb_publishable_bLFSQcGFjJUiSAES1kVkAA_K2HrALBa"
};

// アフィリエイト（予約ボタン）。空のままならボタンは出ません。ここに入れるのは公開用のコードだけです（ログイン情報は入れない）。
// vc_sid / vc_pid: バリューコマース MyLink の sid と pid の数字（ホットペッパーグルメ）
// a8mat: A8.net の一休レストランのリンクコードにある a8mat= の値
window.HP_AFF = { vc_sid: "", vc_pid: "", a8mat: "4BENDO+1SAU42+1OK+NX736" };
