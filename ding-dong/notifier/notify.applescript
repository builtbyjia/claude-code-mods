-- 叮咚的通知小幫手：讀同資料夾的 message.txt（四行：標題、副標題、內文、音效），發一則通知。
-- 編譯成 DingDong.app 之後，通知的圖示就是這個 app 的圖示（橘色吉祥物）。
on run
	set appPath to POSIX path of (path to me)
	set folderPath to do shell script "dirname " & quoted form of appPath
	set messagePath to folderPath & "/message.txt"
	set messageText to read (POSIX file messagePath) as «class utf8»
	set messageLines to paragraphs of messageText
	display notification (item 3 of messageLines) with title (item 1 of messageLines) subtitle (item 2 of messageLines) sound name (item 4 of messageLines)
	-- 腳本太快結束的話通知會來不及送出
	delay 1
end run
