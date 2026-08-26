import mongoose from "mongoose";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

// Raw data provided by the user
const rawLeadLines = [
  { id: "l:1762346788122794", date: "2026-08-01 19:09", platform: "ig", name: "Shivkumar Gupta", phone: "+917208617285", city: "Mumbai", state: "Maharashtra" },
  { id: "l:1521209845980640", date: "2026-08-01 19:01", platform: "ig", name: "Advika Finance Services", phone: "+919860157259", city: "Pune", state: "Maharashtra" },
  { id: "l:4063188923811517", date: "2026-08-01 18:45", platform: "ig", name: "Shubham Parekh", phone: "+919730831159", city: "Satara", state: "Maharashtra" },
  { id: "l:1100942545800305", date: "2026-08-01 18:37", platform: "fb", name: "Pravin Ghode", phone: "+919766048128", city: "Akola", state: "Maharashtra" },
  { id: "l:972269925834714", date: "2026-08-01 18:33", platform: "fb", name: "khursheed ahmad", phone: "+919410108660", city: "Asmoli", state: "Uttar Pradesh" },
  { id: "l:1242973637882968", date: "2026-08-01 18:00", platform: "fb", name: "ajay rane", phone: "+919702164772", city: "Kalyan", state: "Maharashtra" },
  { id: "l:1535612934713413", date: "2026-08-01 17:40", platform: "fb", name: "satyam kumar dubey", phone: "+917049490060", city: "Katni", state: "Madhya Pradesh" },
  { id: "l:1616474486757645", date: "2026-08-01 17:39", platform: "ig", name: "Y.R.Kumbhare", phone: "+918857004731", city: "Saoner", state: "Maharashtra" },
  { id: "l:1541269910804652", date: "2026-08-01 17:22", platform: "ig", name: "sachin patil", phone: "+919860152935", city: "Solapur", state: "Maharashtra" },
  { id: "l:2029843767648411", date: "2026-08-01 16:25", platform: "fb", name: "Pavankumar Kamurti", phone: "+919673799059", city: "Bengaluru", state: "Karnataka" },
  { id: "l:1429951265654435", date: "2026-08-01 16:02", platform: "ig", name: "A. S. Enterprise", phone: "+917304841484", city: "Aurangabad", state: "Maharashtra" },
  { id: "l:2504849376659355", date: "2026-08-01 15:28", platform: "fb", name: "Akshay Pawar", phone: "+917620441075", city: "Yavatmal", state: "Maharashtra" },
  { id: "l:892093920637075", date: "2026-08-01 14:57", platform: "ig", name: "Amol", phone: "+919152016101", city: "Mumbai", state: "Maharashtra" },
  { id: "l:26976352805371543", date: "2026-08-01 14:44", platform: "ig", name: "Amar Nagare", phone: "+919689557555", city: "Ahilyanagar", state: "Maharashtra" },
  { id: "l:1354205046782348", date: "2026-08-01 14:04", platform: "ig", name: "Rohankadam", phone: "+919529327080", city: "Hadapsar (Pune)", state: "Maharashtra" },
  { id: "l:1417333723782467", date: "2026-08-01 13:53", platform: "ig", name: "Om Avhad", phone: "+918862099881", city: "Nashik", state: "Maharashtra" },
  { id: "l:907852388428713", date: "2026-08-01 13:52", platform: "fb", name: "Preeti Bhatt", phone: "+919373149582", city: "Nashik", state: "Maharashtra" },
  { id: "l:2111570559746306", date: "2026-08-01 12:46", platform: "fb", name: "Jay Pawar", phone: "+919975406087", city: "Mumbai", state: "Maharashtra" },
  { id: "l:1841531357220986", date: "2026-08-01 12:42", platform: "fb", name: "Pravin ishwar Thorat", phone: "+917744041439", city: "Bhokar", state: "Maharashtra" },
  { id: "l:1512852860107265", date: "2026-08-01 12:39", platform: "fb", name: "Dharmendra Nanaji Patil", phone: "+919158002996", city: "Nashik", state: "Maharashtra" },
  { id: "l:1578845120540580", date: "2026-08-01 12:14", platform: "fb", name: "S R SHARMA", phone: "+919822162726", city: "Chiplun", state: "Maharashtra" },
  { id: "l:1852623909439654", date: "2026-08-01 11:23", platform: "ig", name: "Kundlik manvarkar", phone: "+919356843885", city: "Aurangabad", state: "Maharashtra" },
  { id: "l:2522812171520428", date: "2026-08-01 11:19", platform: "fb", name: "Saroj v", phone: "+917507662179", city: "Mumbai", state: "Maharashtra" },
  { id: "l:1574895344040374", date: "2026-08-01 10:53", platform: "fb", name: "Silveira Silveira", phone: "+919766422229", city: "Pune", state: "Maharashtra" },
  { id: "l:1696424564901285", date: "2026-08-01 10:26", platform: "fb", name: "Avi", phone: "+918805999899", city: "Hadgaon", state: "Maharashtra" },
  { id: "l:2419933878489504", date: "2026-08-01 05:17", platform: "ig", name: "ananta", phone: "+919820197939", city: "Mumbai", state: "Maharashtra" },
  { id: "l:1287235493323677", date: "2026-08-01 03:40", platform: "fb", name: "Kishor Gadhe", phone: "+917558519977", city: "Shrirampur (Ahmednagar)", state: "Maharashtra" },
  { id: "l:1873123567406001", date: "2026-08-01 02:06", platform: "fb", name: "Bhagwat Bhamare", phone: "+918010617455", city: "Songir (Dhule)", state: "Maharashtra" },
  { id: "l:2534321043660325", date: "2026-08-01 01:25", platform: "fb", name: "Shrikant Handore", phone: "+919272519764", city: "Kalyan", state: "Maharashtra" },
  { id: "l:1801502247683747", date: "2026-08-01 00:49", platform: "ig", name: "Rudra Bansode", phone: "+917397980643", city: "Osmanabad", state: "Maharashtra" },
  { id: "l:1062050723433046", date: "2026-08-01 00:02", platform: "fb", name: "Ranjay pandey", phone: "+919152122282", city: "Kharghar (Navi Mumbai)", state: "Maharashtra" },
  { id: "l:27631978763131834", date: "2026-07-31 23:43", platform: "fb", name: "Praful Akhare", phone: "+919890473120", city: "Anjangaon Surji", state: "Maharashtra" },
  { id: "l:1953661272010565", date: "2026-07-31 23:22", platform: "fb", name: "rajesh mali", phone: "+918983958315", city: "Pune", state: "Maharashtra" },
  { id: "l:878787618324177", date: "2026-07-31 23:15", platform: "ig", name: "Bhakti Digital", phone: "+919021884463", city: "Pune", state: "Maharashtra" },
  { id: "l:1961848171438636", date: "2026-07-31 23:10", platform: "ig", name: "Sheetal Lahare", phone: "+917738285764", city: "Mumbai", state: "Maharashtra" },
  { id: "l:1582529689888215", date: "2026-07-31 22:51", platform: "fb", name: "prakash Baliram Sonwane", phone: "+918484035810", city: "Pune", state: "Maharashtra" },
  { id: "l:1571134684724022", date: "2026-07-31 21:52", platform: "ig", name: "ANANT MADHAVRAO BANKAR", phone: "+917038910162", city: "Jalna", state: "Maharashtra" },
  { id: "l:2548265502283996", date: "2026-07-31 21:12", platform: "ig", name: "Runesh Bade", phone: "+917498576554", city: "Raigad", state: "Maharashtra" },
  { id: "l:1087885053797442", date: "2026-07-31 21:05", platform: "fb", name: "Santosh Hiware", phone: "+918788891910", city: "Nagpur", state: "Maharashtra" },
  { id: "l:1429512862335987", date: "2026-07-31 20:56", platform: "ig", name: "Dattatray Arghade", phone: "+919022039162", city: "Nashik", state: "Maharashtra" },
  { id: "l:1109922674691993", date: "2026-07-31 20:52", platform: "ig", name: "Rohit sherkar", phone: "+919529414143", city: "Pune", state: "Maharashtra" },
  { id: "l:1775583940463835", date: "2026-07-31 20:49", platform: "ig", name: "Anand Jamadar", phone: "+918237513630", city: "Tuljapur", state: "Maharashtra" },
  { id: "l:929936163460301", date: "2026-07-31 20:34", platform: "fb", name: "Padmanabh lokhande", phone: "+918788645407", city: "Alandi (Pune)", state: "Maharashtra" },
  { id: "l:3597386747077478", date: "2026-07-31 19:55", platform: "ig", name: "Only whatsapp", phone: "+919930312690", city: "Mumbai", state: "Maharashtra" },
  { id: "l:1619579442839945", date: "2026-07-31 19:28", platform: "fb", name: "Dattatray mundhe", phone: "+919422705200", city: "Osmanabad", state: "Maharashtra" },
  { id: "l:1019933270648633", date: "2026-07-31 19:23", platform: "fb", name: "Gaurav Rajendra Mankar", phone: "+918010684227", city: "Malegaon", state: "Maharashtra" },
  { id: "l:2164267511131548", date: "2026-07-31 18:42", platform: "fb", name: "Sachin Deshmukh", phone: "+919604520528", city: "Buldana", state: "Maharashtra" },
  { id: "l:991760417197092", date: "2026-07-31 17:04", platform: "fb", name: "Naresh kumar", phone: "+918815818705", city: "Gwalior", state: "Madhya Pradesh" },
  { id: "l:1676961326738660", date: "2026-07-31 16:47", platform: "fb", name: "Suresh Nirmal", phone: "+918446891376", city: "Pune", state: "Maharashtra" },
  { id: "l:1017897127815862", date: "2026-07-31 15:53", platform: "ig", name: "Dnyaneshwar Kate", phone: "+917447368999", city: "Piliv", state: "Maharashtra" },
  { id: "l:1821491965678974", date: "2026-07-31 15:20", platform: "fb", name: "Vicky Singh Yadav", phone: "+919892536658", city: "Mumbai", state: "Maharashtra" },
  { id: "l:1554035166737516", date: "2026-07-31 15:15", platform: "fb", name: "Abhishek Kumar", phone: "+917977583760", city: "Mumbai", state: "Maharashtra" },
  { id: "l:2263138934446003", date: "2026-07-31 14:51", platform: "fb", name: "Shrikrishna Kogekar", phone: "+918698165499", city: "Ajara", state: "Maharashtra" },
  { id: "l:28352236374388691", date: "2026-07-31 14:47", platform: "fb", name: "Satish Ramakant Pathak", phone: "+919850797917", city: "Shahada", state: "Maharashtra" },
  { id: "l:2475322419635354", date: "2026-07-31 13:34", platform: "ig", name: "Yash Palimkar", phone: "+917038691269", city: "Beed", state: "Maharashtra" },
  { id: "l:2220609372061867", date: "2026-07-31 10:54", platform: "fb", name: "Sudhir Vinodia", phone: "+918989133211", city: "Jabalpur", state: "Madhya Pradesh" },
  { id: "l:1564674415063692", date: "2026-07-31 09:46", platform: "ig", name: "Suraj", phone: "+917057084045", city: "Karad", state: "Maharashtra" },
  { id: "l:986461377724310", date: "2026-07-31 09:10", platform: "fb", name: "Ankush Bhosale", phone: "+918788080323", city: "Pune", state: "Maharashtra" },
  { id: "l:997824933075598", date: "2026-07-31 09:09", platform: "fb", name: "Mariya", phone: "+919004037199", city: "Mumbai", state: "Maharashtra" },
  { id: "l:2287320532075897", date: "2026-07-31 09:08", platform: "ig", name: "Rohit Prakash sonavale", phone: "+918999910921", city: "Malkapur", state: "Maharashtra" },
  { id: "l:2917361528602713", date: "2026-07-31 08:59", platform: "fb", name: "pavan SUDHAKAR RATHOD", phone: "+918888319173", city: "Pusad", state: "Maharashtra" },
  { id: "l:1548558320334150", date: "2026-07-31 08:39", platform: "ig", name: "Khaja Burhan Parsuwale", phone: "+919373465008", city: "Jalna", state: "Maharashtra" },
  { id: "l:1751417346038830", date: "2026-07-31 08:19", platform: "fb", name: "Pritam Turankar", phone: "+917385570192", city: "Chandrapur", state: "Maharashtra" },
  { id: "l:1561211442318238", date: "2026-07-31 08:14", platform: "fb", name: "Anup Gujarati", phone: "+917030253545", city: "Sangli", state: "Maharashtra" },
  { id: "l:1327163979620282", date: "2026-07-31 08:06", platform: "fb", name: "Prashant Deshmukh", phone: "+917620225302", city: "Washim", state: "Maharashtra" },
  { id: "l:1025388817053366", date: "2026-07-31 01:04", platform: "fb", name: "SACHIN BIRAR", phone: "+918806450555", city: "Nashik", state: "Maharashtra" },
  { id: "l:2106754703385249", date: "2026-07-31 00:34", platform: "ig", name: "Nilesh Warthe", phone: "+918857850978", city: "Chhatrapati Sambhajinagar", state: "Maharashtra" },
  { id: "l:2237273340352500", date: "2026-07-31 00:23", platform: "fb", name: "Chandrakant Gaikwad", phone: "+919922550739", city: "Pune Camp", state: "Maharashtra" },
  { id: "l:1443731030976292", date: "2026-07-30 23:53", platform: "fb", name: "Mayuresh Suresh Billade", phone: "+919822217580", city: "Nashik", state: "Maharashtra" },
  { id: "l:2093802224538865", date: "2026-07-30 23:37", platform: "fb", name: "Arjun Yadav", phone: "+917620763753", city: "Tumsar", state: "Maharashtra" },
  { id: "l:1050823027347606", date: "2026-07-30 23:24", platform: "ig", name: "Yogiraj Banduji Meshram", phone: "+917887733709", city: "Amravati", state: "Maharashtra" },
  { id: "l:875656701960660", date: "2026-07-30 22:49", platform: "ig", name: "Snehal", phone: "+917666300990", city: "Nagpur", state: "Maharashtra" },
  { id: "l:1003677119099964", date: "2026-07-30 22:47", platform: "ig", name: "Irfan Pathan", phone: "+919322682363", city: "Kopargaon", state: "Maharashtra" },
  { id: "l:1011825448356468", date: "2026-07-30 22:44", platform: "ig", name: "Santosh sharma", phone: "+919076464039", city: "Kalyan", state: "Maharashtra" },
  { id: "l:2089386838283640", date: "2026-07-30 22:30", platform: "ig", name: "Abhay Warghat", phone: "+919765513026", city: "Amravati", state: "Maharashtra" },
  { id: "l:2278509122917141", date: "2026-07-30 22:25", platform: "ig", name: "Milind Jadhav", phone: "+918830465452", city: "Chhatrapati Sambhajinagar", state: "Maharashtra" },
  { id: "l:1702469970963283", date: "2026-07-30 21:58", platform: "ig", name: "Ajay Borkar", phone: "+917507339461", city: "Akola", state: "Maharashtra" },
  { id: "l:1393586379357396", date: "2026-07-30 21:41", platform: "fb", name: "Vishal Divase", phone: "+919420399396", city: "Kolhapur", state: "Maharashtra" },
  { id: "l:1758229668865321", date: "2026-07-30 21:01", platform: "fb", name: "Samadhan Lahane", phone: "+917030640153", city: "Aurangabad", state: "Maharashtra" },
  { id: "l:4994131040813757", date: "2026-07-30 20:58", platform: "ig", name: "Harshad Pawar", phone: "+917499216124", city: "Ahmednagar", state: "Maharashtra" },
  { id: "l:1002649472597546", date: "2026-07-30 20:50", platform: "ig", name: "Kunal", phone: "+917770044435", city: "Chikhali", state: "Maharashtra" },
  { id: "l:947815908354779", date: "2026-07-30 20:29", platform: "ig", name: "Aman Kesarwani", phone: "+919823077476", city: "Nagpur", state: "Maharashtra" },
  { id: "l:1406663991309921", date: "2026-07-30 20:27", platform: "fb", name: "Sanjay", phone: "+919420391898", city: "Nagpur", state: "Maharashtra" },
  { id: "l:1073767471893618", date: "2026-07-30 19:51", platform: "ig", name: "Shubham Mishra", phone: "+917796803623", city: "Gadhchiroli", state: "Maharashtra" },
  { id: "l:2039115310040262", date: "2026-07-30 19:39", platform: "ig", name: "Naresh Minekar", phone: "+919028524740", city: "Pune", state: "Maharashtra" },
  { id: "l:1227198533812083", date: "2026-07-30 19:25", platform: "fb", name: "Akash Mane", phone: "+917666370710", city: "Ratnagiri", state: "Maharashtra" },
  { id: "l:1789273275588061", date: "2026-07-30 19:15", platform: "fb", name: "Samadhan Bhosale", phone: "+919881555009", city: "Karmala", state: "Maharashtra" },
  { id: "l:1583246210138985", date: "2026-07-30 19:11", platform: "ig", name: "Maneish Rajput", phone: "+918669691992", city: "Vasai West", state: "Maharashtra" },
  { id: "l:1443745824258080", date: "2026-07-30 19:10", platform: "fb", name: "Rohit Latta Uttamrao Parsode", phone: "+919156865555", city: "Parbhani", state: "Maharashtra" },
  { id: "l:1748993123185379", date: "2026-07-30 17:18", platform: "ig", name: "Datta achyut kamble", phone: "+919167538429", city: "Mumbai", state: "Maharashtra" },
  { id: "l:2236203743900117", date: "2026-07-30 16:09", platform: "fb", name: "Praveen P", phone: "+917877930955", city: "Anantapur", state: "Andhra Pradesh" },
  { id: "l:1033207116022432", date: "2026-07-30 14:39", platform: "ig", name: "Nilesh Govind haral", phone: "+918625839464", city: "Dhule", state: "Maharashtra" },
  { id: "l:2625410471261417", date: "2026-07-30 13:53", platform: "fb", name: "Jadhav", phone: "+919096916912", city: "Pimpri", state: "Maharashtra" },
  { id: "l:1240532158125276", date: "2026-07-30 13:02", platform: "ig", name: "Sunil Bagad", phone: "+918698980320", city: "Pune", state: "Maharashtra" },
  { id: "l:1035084739305506", date: "2026-07-30 12:50", platform: "ig", name: "Mahibub Shaikh", phone: "+919921375789", city: "Pune", state: "Maharashtra" },
  { id: "l:2483840695469855", date: "2026-07-30 12:50", platform: "fb", name: "gajanan raju banjara", phone: "+917507971066", city: "Nashik", state: "Maharashtra" },
  { id: "l:1935588057139630", date: "2026-07-30 11:23", platform: "ig", name: "Vikrant Mohite", phone: "+919604689463", city: "Kolhapur", state: "Maharashtra" },
  { id: "l:2576991092766043", date: "2026-07-30 11:18", platform: "fb", name: "Ashok Giri", phone: "+919545666455", city: "Mumbai", state: "Maharashtra" },
  { id: "l:1564372868458568", date: "2026-07-30 09:43", platform: "fb", name: "VIPIN Chandwani", phone: "+917974444326", city: "Nagpur", state: "Maharashtra" },
  { id: "l:1685314849193498", date: "2026-07-30 09:04", platform: "fb", name: "Surendra Surwase", phone: "+918180086753", city: "Akkalkot", state: "Maharashtra" },
  { id: "l:2049682162303241", date: "2026-07-30 08:58", platform: "ig", name: "Kshitij Nikam", phone: "+919637620656", city: "Amravati", state: "Maharashtra" },
  { id: "l:2482076872271032", date: "2026-07-30 08:29", platform: "ig", name: "Manas Nerkar", phone: "+919309881299", city: "Nashik", state: "Maharashtra" },
  { id: "l:1540695803651757", date: "2026-07-30 08:10", platform: "ig", name: "Kiran", phone: "+917798871272", city: "Pune", state: "Maharashtra" },
  { id: "l:1618427429902872", date: "2026-07-30 07:49", platform: "ig", name: "Ramkaran gaund", phone: "+918275876029", city: "Sindhudurg", state: "Maharashtra" },
  { id: "l:2837386363293722", date: "2026-07-30 06:22", platform: "ig", name: "Bharat Patil", phone: "+919320608100", city: "Kolhapur", state: "Maharashtra" },
  { id: "l:884212207754268", date: "2026-07-30 05:55", platform: "fb", name: "Somnath Kshirsagar", phone: "+919209562575", city: "Nashik", state: "Maharashtra" },
  { id: "l:937267382721290", date: "2026-07-30 01:51", platform: "fb", name: "Kunal Ranpise", phone: "+918108600913", city: "Kalyan", state: "Maharashtra" },
  { id: "l:1912565406096267", date: "2026-07-30 00:32", platform: "ig", name: "Ganesh Kolekar", phone: "+917758907971", city: "Others", state: "Maharashtra" },
  { id: "l:1560966142070501", date: "2026-07-30 00:29", platform: "ig", name: "Shaikh shab", phone: "+919323006005", city: "Mumbai", state: "Maharashtra" },
  { id: "l:849180224792965", date: "2026-07-30 00:27", platform: "ig", name: "Rohit narendra ukhare", phone: "+918421988035", city: "Nagpur", state: "Maharashtra" },
  { id: "l:27355792227456676", date: "2026-07-30 00:23", platform: "ig", name: "ak marketing", phone: "+919960424667", city: "Pune", state: "Maharashtra" },
  { id: "l:2306970509710923", date: "2026-07-30 00:11", platform: "fb", name: "Satyam Datrange", phone: "+917972769730", city: "Pune", state: "Maharashtra" },
  { id: "l:27647798511529053", date: "2026-07-29 23:42", platform: "ig", name: "Viraj Gaikwad", phone: "+917385296077", city: "Pune", state: "Maharashtra" },
  { id: "l:1032528992965119", date: "2026-07-29 23:32", platform: "fb", name: "durga ajay tekale", phone: "+918433722023", city: "Pune", state: "Maharashtra" },
  { id: "l:2579473902479660", date: "2026-07-29 22:15", platform: "fb", name: "Satish Lahulkar", phone: "+919371717393", city: "Akola", state: "Maharashtra" },
  { id: "l:1450788737260709", date: "2026-07-29 21:24", platform: "ig", name: "Dhiraj Amol Randive", phone: "+918446228841", city: "Ranjangaon", state: "Maharashtra" },
  { id: "l:1084366064107453", date: "2026-07-29 21:24", platform: "ig", name: "Chanderkant Kalekar", phone: "+917972717673", city: "Vadgaon", state: "Maharashtra" },
  { id: "l:1042514335094812", date: "2026-07-29 21:13", platform: "ig", name: "Pasenjit Nath", phone: "+918119868557", city: "Dharmanagar", state: "Tripura" },
  { id: "l:1022605133726847", date: "2026-07-29 21:05", platform: "fb", name: "sagar", phone: "+918010277587", city: "Aurangabad", state: "Maharashtra" },
  { id: "l:1031725292898951", date: "2026-07-29 20:26", platform: "ig", name: "Vishu Grewal", phone: "+918607205215", city: "Rohtak", state: "Haryana" },
  { id: "l:1957058821647384", date: "2026-07-29 20:24", platform: "ig", name: "Amir Nadaf", phone: "+918459231179", city: "Jalkot", state: "Maharashtra" },
  { id: "l:1028262759966565", date: "2026-07-29 20:08", platform: "ig", name: "Rajesh Parab", phone: "+919221273581", city: "Mumbai", state: "Maharashtra" },
  { id: "l:1023974450445968", date: "2026-07-29 20:08", platform: "fb", name: "Rupesh Sable", phone: "+919373870621", city: "Amravati", state: "Maharashtra" },
  { id: "l:27742669358689224", date: "2026-07-29 19:33", platform: "fb", name: "Akshay", phone: "+919768029176", city: "Navi Mumbai", state: "Maharashtra" },
  { id: "l:1124116240189151", date: "2026-07-29 19:10", platform: "fb", name: "Somnath Kshirsagar", phone: "+919096668032", city: "Taklimiya", state: "Maharashtra" },
  { id: "l:1065963002669791", date: "2026-07-29 19:08", platform: "fb", name: "Sachin Baban Dundale", phone: "+919664802847", city: "Satara", state: "Maharashtra" },
  { id: "l:1544290100479215", date: "2026-07-29 18:50", platform: "fb", name: "shaikh asif fateh Mohammad", phone: "+919595846262", city: "Buldana", state: "Maharashtra" },
  { id: "l:1062285052873260", date: "2026-07-29 17:39", platform: "ig", name: "Chetan pawar", phone: "+919284934464", city: "Mumbai", state: "Maharashtra" },
  { id: "l:1397274025610902", date: "2026-07-29 17:28", platform: "ig", name: "TEJAS JOSHI", phone: "+919423219673", city: "Pune", state: "Maharashtra" },
  { id: "l:1274033568032568", date: "2026-07-29 17:16", platform: "ig", name: "Sandesh shelke", phone: "+919767024028", city: "Nanded", state: "Maharashtra" },
  { id: "l:2764334190626639", date: "2026-07-29 17:10", platform: "ig", name: "Mayur Jadhav", phone: "+919028281191", city: "Malegaon", state: "Maharashtra" },
  { id: "l:1369779837832796", date: "2026-07-29 16:35", platform: "fb", name: "Nilesh Jambhule", phone: "+917972601406", city: "Nagbhir", state: "Maharashtra" },
  { id: "l:2097506851197550", date: "2026-07-29 15:20", platform: "ig", name: "MR Rk Here", phone: "+918208029515", city: "Sambhajinagar", state: "Maharashtra" },
  { id: "l:1031708479505370", date: "2026-07-29 14:56", platform: "ig", name: "Kirankumar", phone: "+919146796459", city: "Dhule", state: "Maharashtra" },
  { id: "l:1598356011645606", date: "2026-07-29 14:51", platform: "ig", name: "Shubham kamble", phone: "+918668538522", city: "Latur", state: "Maharashtra" },
  { id: "l:1594132715585795", date: "2026-07-29 14:43", platform: "ig", name: "Sandeep Savita", phone: "+917518381764", city: "Palghar", state: "Maharashtra" },
  { id: "l:1724753318572034", date: "2026-07-29 13:50", platform: "fb", name: "Pankaj", phone: "+919702779879", city: "Mumbai", state: "Maharashtra" },
  { id: "l:1353481006871805", date: "2026-07-29 13:14", platform: "ig", name: "Sandeep Wyawahare", phone: "+919975701965", city: "Nagpur", state: "Maharashtra" },
  { id: "l:1954686145246739", date: "2026-07-29 13:12", platform: "ig", name: "Swaraafin Micro Finance", phone: "+919284278383", city: "Pune", state: "Maharashtra" },
  { id: "l:1368622064633079", date: "2026-07-29 13:12", platform: "fb", name: "Amol ghodke", phone: "+919209103113", city: "Latur", state: "Maharashtra" },
  { id: "l:1551433359789825", date: "2026-07-29 12:32", platform: "ig", name: "Sagar Usare", phone: "+918806592029", city: "Aurangabad", state: "Maharashtra" },
  { id: "l:2512980025841500", date: "2026-07-29 12:32", platform: "ig", name: "Avi Patil", phone: "+918010444810", city: "Pune", state: "Maharashtra" },
  { id: "l:1684017362899614", date: "2026-07-29 12:09", platform: "ig", name: "Devendra", phone: "+917249830846", city: "Pune", state: "Maharashtra" },
  { id: "l:1758313085174110", date: "2026-07-29 11:31", platform: "ig", name: "swapnil binwade", phone: "+917998871414", city: "Pune", state: "Maharashtra" },
  { id: "l:948295641004147", date: "2026-07-29 07:41", platform: "fb", name: "Asif shaikh", phone: "+918421780802", city: "Latur", state: "Maharashtra" },
  { id: "l:1333412695173022", date: "2026-07-29 07:23", platform: "ig", name: "Kalyani", phone: "+919773478289", city: "Mumbai", state: "Maharashtra" },
  { id: "l:1029815430040031", date: "2026-07-29 07:13", platform: "fb", name: "Samadhan Ramdas Nikalje", phone: "+919545336418", city: "Deulgaon Raja", state: "Maharashtra" },
  { id: "l:1041791951904620", date: "2026-07-29 06:25", platform: "fb", name: "amol ashok sawant", phone: "+918766504246", city: "Solapur", state: "Maharashtra" },
  { id: "l:3209658875885899", date: "2026-07-28 23:58", platform: "ig", name: "PG", phone: "+919022990803", city: "Navi Mumbai", state: "Maharashtra" },
  { id: "l:1771769523989380", date: "2026-07-28 23:49", platform: "ig", name: "Akash Shashikant Sutar", phone: "+919503021200", city: "Pune", state: "Maharashtra" },
  { id: "l:4341535429494607", date: "2026-07-28 23:47", platform: "ig", name: "Pritam Lanjewar", phone: "+919322782361", city: "Hinganghat", state: "Maharashtra" },
  { id: "l:3926077494201219", date: "2026-07-28 23:12", platform: "ig", name: "Sagar", phone: "+919834530048", city: "Baramati", state: "Maharashtra" },
  { id: "l:1021437577271718", date: "2026-07-28 22:08", platform: "ig", name: "S S Loan Services", phone: "+919529054417", city: "Mumbai", state: "Maharashtra" },
  { id: "l:1759708455030376", date: "2026-07-28 21:45", platform: "fb", name: "Alfaj Shaikh", phone: "+918177873633", city: "Jaysingpur", state: "Maharashtra" },
  { id: "l:3965673817061248", date: "2026-07-28 21:38", platform: "ig", name: "Mahesh Vilas Tarage", phone: "+918421318571", city: "Shrirampur", state: "Maharashtra" },
  { id: "l:1004771488847594", date: "2026-07-28 21:24", platform: "fb", name: "dnyaneshwar Bhivsan Tade", phone: "+919405751558", city: "Jalgaon", state: "Maharashtra" },
  { id: "l:1587183189426658", date: "2026-07-28 21:23", platform: "ig", name: "Aditya Nagawade", phone: "+917499015739", city: "Pune", state: "Maharashtra" },
  { id: "l:1603609834693985", date: "2026-07-28 21:02", platform: "fb", name: "salim pyaruminya shaikh", phone: "+919404573380", city: "Parli Vaijnath", state: "Maharashtra" },
  { id: "l:1760222518494495", date: "2026-07-28 20:52", platform: "fb", name: "vinod Ghormare", phone: "+917066285606", city: "Savner", state: "Maharashtra" },
  { id: "l:1629047769227089", date: "2026-07-28 20:50", platform: "ig", name: "Shubham Ade", phone: "+918904228183", city: "Lonar", state: "Maharashtra" },
  { id: "l:1042728844814680", date: "2026-07-28 20:32", platform: "ig", name: "Rahul kakade", phone: "+919423691932", city: "Aurangabad", state: "Maharashtra" },
  { id: "l:27668535936130133", date: "2026-07-28 20:16", platform: "fb", name: "Mandar G Divashikar", phone: "+917722007292", city: "Kolhapur", state: "Maharashtra" },
  { id: "l:1025954416744932", date: "2026-07-28 20:02", platform: "ig", name: "ZUBER KHAN", phone: "+918698746157", city: "Balapur", state: "Maharashtra" },
  { id: "l:923784507435229", date: "2026-07-28 18:26", platform: "fb", name: "Sagar Ramesh Khisti", phone: "+919146264309", city: "Ahmednagar", state: "Maharashtra" },
  { id: "l:1808025800164470", date: "2026-07-28 18:17", platform: "fb", name: "Kishor Korgaonkar", phone: "+919870841466", city: "Mumbai", state: "Maharashtra" },
  { id: "l:1351117883230944", date: "2026-07-28 17:49", platform: "fb", name: "harshal kshirsagar", phone: "+917550795050", city: "Pune", state: "Maharashtra" },
  { id: "l:1369070935350109", date: "2026-07-28 17:41", platform: "fb", name: "Durvesh Ravi Khokale", phone: "+918898849866", city: "Mumbai", state: "Maharashtra" },
  { id: "l:2982763248728019", date: "2026-07-28 17:39", platform: "fb", name: "Surendra Sonawane", phone: "+918208824467", city: "Jalgaon", state: "Maharashtra" },
  { id: "l:1707102507187504", date: "2026-07-28 17:12", platform: "fb", name: "siddesh rane", phone: "+917774022434", city: "Mumbai", state: "Maharashtra" },
  { id: "l:3606511712839279", date: "2026-07-28 16:16", platform: "ig", name: "Nana chavan", phone: "+917558545440", city: "Suregaon Rasta", state: "Maharashtra" },
  { id: "l:1498779721937425", date: "2026-07-28 15:18", platform: "ig", name: "Manthan Patankar", phone: "+919689550330", city: "Ichalkaranji", state: "Maharashtra" },
  { id: "l:1524530612222927", date: "2026-07-28 14:07", platform: "ig", name: "Shirkrushan Hudekar", phone: "+919145873438", city: "Nagpur", state: "Maharashtra" },
  { id: "l:1022076084008437", date: "2026-07-28 14:05", platform: "fb", name: "Bhushan Rajiv Puri", phone: "+917744082235", city: "Pandharkawada", state: "Maharashtra" },
  { id: "l:37184557654493011", date: "2026-07-28 13:53", platform: "fb", name: "Tejas Jawanjal", phone: "+917821810249", city: "Amravati", state: "Maharashtra" },
  { id: "l:1567070661587743", date: "2026-07-28 13:17", platform: "ig", name: "Pratap biragal", phone: "+919309738622", city: "Pune", state: "Maharashtra" },
  { id: "l:28309632498673062", date: "2026-07-28 13:11", platform: "ig", name: "Ajit Bhosale", phone: "+918446004420", city: "Pune", state: "Maharashtra" },
  { id: "l:1359689155572531", date: "2026-07-28 13:06", platform: "ig", name: "Akhi Yadav", phone: "+919987081056", city: "Mumbai", state: "Maharashtra" },
  { id: "l:2507422999685917", date: "2026-07-28 13:05", platform: "ig", name: "Aniket Madhukar Moin", phone: "+917822805213", city: "Aurangabad", state: "Maharashtra" },
  { id: "l:1521328649234513", date: "2026-07-28 12:58", platform: "ig", name: "Muzammil Shaikh", phone: "+919970001188", city: "Solapur", state: "Maharashtra" },
  { id: "l:1735986304113796", date: "2026-07-28 11:37", platform: "fb", name: "Tungle Prashant", phone: "+917045474728", city: "Mumbai", state: "Maharashtra" },
  { id: "l:1515105573148449", date: "2026-07-28 09:57", platform: "fb", name: "Prashant Yeul", phone: "+918698252097", city: "Aurangabad", state: "Maharashtra" },
  { id: "l:4355506948006141", date: "2026-07-28 08:25", platform: "ig", name: "Amar Wavhale", phone: "+919370249234", city: "Ambajogai", state: "Maharashtra" },
  { id: "l:28722418497348687", date: "2026-07-28 06:21", platform: "fb", name: "santosh vitkar", phone: "+919657563183", city: "Pune", state: "Maharashtra" },
  { id: "l:1718793253139757", date: "2026-07-28 04:27", platform: "fb", name: "Nilesh Kharche", phone: "+917304395011", city: "Titwala", state: "Maharashtra" },
  { id: "l:3571381919695310", date: "2026-07-28 02:56", platform: "ig", name: "Hafiz", phone: "+919890454714", city: "Solapur", state: "Maharashtra" },
  { id: "l:1366289305508494", date: "2026-07-28 01:57", platform: "ig", name: "Nilesh ramchandra singg", phone: "+919503361418", city: "Palghar", state: "Maharashtra" },
  { id: "l:874282909095551", date: "2026-07-28 01:01", platform: "ig", name: "GREESH HIRANAND LASSI", phone: "+919209151720", city: "Ulhasnagar", state: "Maharashtra" },
  { id: "l:1953186992025431", date: "2026-07-28 00:31", platform: "ig", name: "Sagar bokare", phone: "+918669737107", city: "Aurangabad", state: "Maharashtra" },
  { id: "l:2096381677981179", date: "2026-07-27 22:59", platform: "ig", name: "Shailesh Bhingare", phone: "+919665761674", city: "Pune", state: "Maharashtra" },
  { id: "l:1043926968285357", date: "2026-07-27 22:48", platform: "ig", name: "Akash kashinath shinde", phone: "+919970190420", city: "Dhule", state: "Maharashtra" },
  { id: "l:2128616834367979", date: "2026-07-27 22:25", platform: "ig", name: "Ravindra Potdar", phone: "+918182825454", city: "Kolhapur", state: "Maharashtra" },
  { id: "l:3324542694392278", date: "2026-07-27 22:23", platform: "ig", name: "Anwar Shaikh", phone: "+918308174016", city: "Latur", state: "Maharashtra" },
  { id: "l:2468429110287974", date: "2026-07-27 22:19", platform: "ig", name: "Sharukkha Pathan", phone: "+919730559736", city: "Aurangabad", state: "Maharashtra" },
  { id: "l:1352725253720167", date: "2026-07-27 22:18", platform: "ig", name: "PAVAN PARSHRAM Badave", phone: "+918624998426", city: "Ichalkaranji", state: "Maharashtra" },
  { id: "l:871295912443066", date: "2026-07-27 22:06", platform: "ig", name: "Mahesh Chagan Yajgar", phone: "+919511878090", city: "Pandharpur", state: "Maharashtra" },
  { id: "l:1228173932740090", date: "2026-07-27 21:59", platform: "ig", name: "yogesh sangule", phone: "+918329095860", city: "Jalna", state: "Maharashtra" },
  { id: "l:1084400974515035", date: "2026-07-27 21:37", platform: "ig", name: "Dipak Ahire", phone: "+919156915121", city: "Malegaon", state: "Maharashtra" },
  { id: "l:1040656611697906", date: "2026-07-27 21:34", platform: "ig", name: "Swapnil Dada Kekan", phone: "+918999732931", city: "Pune Daund", state: "Maharashtra" },
  { id: "l:1388171419903375", date: "2026-07-27 21:08", platform: "ig", name: "Kunal Dhule", phone: "+917620922474", city: "Dhule", state: "Maharashtra" },
  { id: "l:2062020191093155", date: "2026-07-27 21:00", platform: "ig", name: "ROHIT", phone: "+919284040136", city: "Kolhapur", state: "Maharashtra" },
  { id: "l:1573437371171916", date: "2026-07-27 20:11", platform: "ig", name: "SAGAR MACHHINDRA BHALERAO", phone: "+917030287006", city: "Kopargaon", state: "Maharashtra" },
  { id: "l:1684610365949014", date: "2026-07-27 20:02", platform: "fb", name: "Raj Mak", phone: "+918828346576", city: "Thane Mira Road", state: "Maharashtra" },
  { id: "l:1835173504524462", date: "2026-07-27 19:31", platform: "ig", name: "Akash Landge", phone: "+917028547982", city: "Pune Chakan", state: "Maharashtra" },
  { id: "l:1565550655177065", date: "2026-07-27 19:28", platform: "ig", name: "Samir Pandurang Kamble", phone: "+917262802509", city: "Pune", state: "Maharashtra" },
  { id: "l:1363612259077103", date: "2026-07-27 18:17", platform: "ig", name: "Badri Doifode", phone: "+919545274840", city: "Sindkhed Raja", state: "Maharashtra" },
  { id: "l:1609195337471828", date: "2026-07-27 17:00", platform: "ig", name: "Ramswami shavne", phone: "+917028417336", city: "Mumbai", state: "Maharashtra" },
  { id: "l:1588710722965939", date: "2026-07-27 16:15", platform: "ig", name: "Gaurang Thakkar", phone: "+918799208901", city: "Gandhinagar", state: "Gujarat" },
  { id: "l:915620501559873", date: "2026-07-27 16:13", platform: "ig", name: "Vijay Nikam", phone: "+919049475434", city: "Chhatrapati Sambhajinagar", state: "Maharashtra" },
  { id: "l:1554892122761362", date: "2026-07-27 15:48", platform: "ig", name: "Avinash Gawai", phone: "+917262083035", city: "Mehkar", state: "Maharashtra" },
  { id: "l:1608781267285559", date: "2026-07-27 15:37", platform: "ig", name: "Mr. Shakya Kamble", phone: "+919834505620", city: "Ahmednagar", state: "Maharashtra" },
  { id: "l:2017389945805774", date: "2026-07-27 15:11", platform: "fb", name: "Ranjit Bhimrao Kamble", phone: "+919096403978", city: "Latur", state: "Maharashtra" },
  { id: "l:907726118418379", date: "2026-07-27 14:53", platform: "ig", name: "Prem paval", phone: "+9188855063434", city: "Solapur", state: "Maharashtra" },
  { id: "l:2061067551283277", date: "2026-07-27 14:40", platform: "ig", name: "SUPERS CARS NAGPUR", phone: "+918552951765", city: "Nagpur", state: "Maharashtra" },
  { id: "l:1049296024268953", date: "2026-07-27 14:20", platform: "ig", name: "Aarya", phone: "+917719803668", city: "Thane", state: "Maharashtra" },
  { id: "l:2122756918641260", date: "2026-07-27 14:19", platform: "ig", name: "sachin gaikwad", phone: "+917057870143", city: "Nanded", state: "Maharashtra" },
  { id: "l:1347793037565892", date: "2026-07-27 14:02", platform: "ig", name: "Roshan Takrani", phone: "+919421747355", city: "Khamgaon", state: "Maharashtra" },
  { id: "l:998250476319291", date: "2026-07-27 13:53", platform: "ig", name: "Ashwini Surve", phone: "+917887429277", city: "Satara", state: "Maharashtra" },
  { id: "l:1031011429530124", date: "2026-07-27 13:19", platform: "ig", name: "S patil", phone: "+919370590382", city: "Dhule", state: "Maharashtra" },
  { id: "l:1546467107020659", date: "2026-07-27 12:28", platform: "ig", name: "GYANENDRA KUMAR THAKUR", phone: "+917309741999", city: "Chandauli", state: "Uttar Pradesh" },
  { id: "l:1071599872192596", date: "2026-07-27 12:26", platform: "ig", name: "Akshay PATIL", phone: "+919922052797", city: "Aurangabad", state: "Maharashtra" },
  { id: "l:2266991930506897", date: "2026-07-27 12:23", platform: "fb", name: "Prakash Hatwar", phone: "+917387882595", city: "Ramtek", state: "Maharashtra" },
  { id: "l:1956181671738464", date: "2026-07-27 12:05", platform: "ig", name: "Abhishek Gajanan Warakhade", phone: "+919067109598", city: "Wardha", state: "Maharashtra" },
  { id: "l:2206644663462893", date: "2026-07-27 11:34", platform: "fb", name: "Shashikant Mandhare", phone: "+919922939988", city: "Wardha", state: "Maharashtra" },
  { id: "l:28310508158555772", date: "2026-07-27 11:13", platform: "fb", name: "Navnath Bugde", phone: "+919930103511", city: "Mumbai", state: "Maharashtra" },
  { id: "l:3321476801356817", date: "2026-07-27 10:01", platform: "ig", name: "Shrikant Sanjay Dhokare", phone: "+919637948697", city: "Dindori", state: "Maharashtra" },
  { id: "l:1668405080893843", date: "2026-07-27 09:56", platform: "ig", name: "Amit Dabhi", phone: "+919033804208", city: "Vadodara", state: "Gujarat" },
  { id: "l:1352596777084970", date: "2026-07-27 09:54", platform: "fb", name: "Ajit Bhujbal", phone: "+918600483684", city: "Solapur", state: "Maharashtra" },
  { id: "l:1740139757012239", date: "2026-07-27 08:40", platform: "ig", name: "amol karande", phone: "+919922267650", city: "Devrukh", state: "Maharashtra" },
  { id: "l:2040332816568783", date: "2026-07-27 08:05", platform: "ig", name: "Ravindra B Kumbhar", phone: "+919545464903", city: "Kolhapur", state: "Maharashtra" },
  { id: "l:1973450676643083", date: "2026-07-27 07:39", platform: "fb", name: "Amol Suresh Kale", phone: "+918799813279", city: "Nagpur", state: "Maharashtra" },
  { id: "l:3827653094059132", date: "2026-07-27 07:38", platform: "ig", name: "Avinash Akhilesh pande", phone: "+919168847800", city: "Kolhapur", state: "Maharashtra" },
  { id: "l:1039209392026542", date: "2026-07-27 07:32", platform: "ig", name: "Chandrakant Toskar", phone: "+919004590627", city: "Ratnagiri", state: "Maharashtra" },
  { id: "l:1025315400488278", date: "2026-07-27 07:17", platform: "fb", name: "Sachin salve", phone: "+919561103765", city: "Sangamner", state: "Maharashtra" },
  { id: "l:1016467507836849", date: "2026-07-27 02:48", platform: "ig", name: "asokk", phone: "+919769302555", city: "Mumbai", state: "Maharashtra" },
  { id: "l:27282562484780088", date: "2026-07-27 02:44", platform: "ig", name: "Aniket Anil Sankpal", phone: "+917219888804", city: "Sangli", state: "Maharashtra" },
  { id: "l:1016691224528975", date: "2026-07-27 01:44", platform: "ig", name: "SANDEEP ARJUNRAO ZINE", phone: "+919158301515", city: "Aurangabad", state: "Maharashtra" },
  { id: "l:27978496721760132", date: "2026-07-27 01:17", platform: "ig", name: "Sunil Shelake", phone: "+919665595565", city: "Kolhapur", state: "Maharashtra" },
  { id: "l:2464061637448752", date: "2026-07-27 00:11", platform: "ig", name: "Ganesh Wayafalkar", phone: "+918999760703", city: "Kolhapur", state: "Maharashtra" },
  { id: "l:1946037062781569", date: "2026-07-26 23:57", platform: "ig", name: "Shivam", phone: "+917875708935", city: "Pune", state: "Maharashtra" },
  { id: "l:1671615697248606", date: "2026-07-26 23:55", platform: "fb", name: "Ratna Palekar", phone: "+919881033029", city: "Satara", state: "Maharashtra" },
  { id: "l:1399236128834935", date: "2026-07-26 23:48", platform: "ig", name: "Indrapal Singh", phone: "+918263902551", city: "Nagpur", state: "Maharashtra" },
  { id: "l:1701006851165618", date: "2026-07-26 23:24", platform: "ig", name: "ARVIND DEVIDAS YADAV", phone: "+917219246024", city: "Pune", state: "Maharashtra" },
  { id: "l:2213322662850145", date: "2026-07-26 22:48", platform: "fb", name: "siddhanath Anna Kate", phone: "+919226742915", city: "Malshiras", state: "Maharashtra" },
  { id: "l:1019573370783466", date: "2026-07-26 22:36", platform: "ig", name: "Shashi pol", phone: "+918055186059", city: "Pune Dighi", state: "Maharashtra" },
  { id: "l:1808691927208717", date: "2026-07-26 22:35", platform: "ig", name: "Sanjay achdev", phone: "+917744807000", city: "Thane", state: "Maharashtra" },
  { id: "l:2199724804144537", date: "2026-07-26 22:17", platform: "ig", name: "Pritesh Pandey", phone: "+917414965318", city: "Mumbai", state: "Maharashtra" },
  { id: "l:2083547949038863", date: "2026-07-26 22:10", platform: "ig", name: "Mangesh sirsat", phone: "+919284197035", city: "Amravati", state: "Maharashtra" },
  { id: "l:1349772900685816", date: "2026-07-26 22:06", platform: "fb", name: "Dhiraj Barathe", phone: "+919762441622", city: "Pune", state: "Maharashtra" },
  { id: "l:1045170491434039", date: "2026-07-26 21:52", platform: "ig", name: "Ganesh", phone: "+917744900720", city: "Aurangabad", state: "Maharashtra" },
  { id: "l:1022658927345655", date: "2026-07-26 21:48", platform: "ig", name: "Mushfique Shaikh", phone: "+919405475217", city: "Amravati", state: "Maharashtra" },
  { id: "l:1263775222396117", date: "2026-07-26 20:29", platform: "ig", name: "Shankar Jadhao", phone: "+919503702891", city: "Washim", state: "Maharashtra" },
  { id: "l:2367735894055552", date: "2026-07-26 19:59", platform: "fb", name: "Sunil Agre", phone: "+917620475234", city: "Aurangabad", state: "Maharashtra" },
  { id: "l:1026813683317559", date: "2026-07-26 19:50", platform: "ig", name: "samadhan gaikwad", phone: "+918767128429", city: "Pune Pimpri", state: "Maharashtra" },
  { id: "l:1589841369221085", date: "2026-07-26 19:50", platform: "ig", name: "alonelife43_", phone: "+919921991489", city: "Pune", state: "Maharashtra" },
  { id: "l:2229904481190855", date: "2026-07-26 19:45", platform: "fb", name: "Tushar Jadhab", phone: "+918108849012", city: "Kalyan West", state: "Maharashtra" },
  { id: "l:2047932506110045", date: "2026-07-26 19:42", platform: "ig", name: "Pritam Jatav", phone: "+919424986295", city: "Deori", state: "Madhya Pradesh" },
  { id: "l:2253046788785351", date: "2026-07-26 19:41", platform: "ig", name: "Vijay", phone: "+918956575760", city: "Pune", state: "Maharashtra" }
];

function normalizePhone(phoneStr) {
  if (!phoneStr) return "";
  const cleaned = phoneStr.replace(/\D/g, "");
  if (cleaned.length > 10) {
    return cleaned.slice(-10);
  }
  return cleaned;
}

async function run() {
  const uri = process.env.MONGO_URI;
  console.log("Connecting to MongoDB...");
  await mongoose.connect(uri);
  console.log("Connected to MongoDB!");

  const users = await mongoose.connection.db.collection("users").find({}).toArray();
  console.log(`Found ${users.length} total users in DB.`);

  // Create lookup maps by 10-digit phone
  const userByPhone = new Map();
  for (const u of users) {
    if (u.phone) {
      const p = normalizePhone(u.phone);
      if (p) {
        userByPhone.set(p, u);
      }
    }
  }

  const processedLeads = [];
  let registeredCount = 0;
  let remainingCount = 0;

  for (const lead of rawLeadLines) {
    const cleanPhone = normalizePhone(lead.phone);
    const dbUser = userByPhone.get(cleanPhone);

    const isRegistered = !!dbUser;
    const partnerRole = dbUser?.role || "NOT_REGISTERED";
    const isPartner = isRegistered && dbUser.role === "PARTNER";

    if (isRegistered) {
      registeredCount++;
    } else {
      remainingCount++;
    }

    processedLeads.push({
      ...lead,
      cleanPhone,
      isRegistered,
      isPartner,
      dbUser: dbUser ? {
        id: dbUser._id?.toString(),
        name: `${dbUser.firstName || ""} ${dbUser.lastName || ""}`.trim(),
        role: dbUser.role,
        status: dbUser.status,
        partnerCode: dbUser.partnerCode || dbUser.referralCode || "N/A",
        joinDate: dbUser.createdAt || dbUser.joinDate || "N/A"
      } : null
    });
  }

  console.log("\n=== SUMMARY ===");
  console.log(`Total Leads: ${processedLeads.length}`);
  console.log(`Registered in App: ${registeredCount}`);
  console.log(`Remaining to Register: ${remainingCount}`);

  console.log("\n--- REGISTERED USERS FOUND ---");
  const registeredLeads = processedLeads.filter(l => l.isRegistered);
  registeredLeads.forEach(l => {
    console.log(`- ${l.name} (${l.phone}) -> DB: ${l.dbUser.name} [Role: ${l.dbUser.role}, Code: ${l.dbUser.partnerCode}]`);
  });

  console.log(`\n--- REMAINING TO REGISTER (${processedLeads.filter(l => !l.isRegistered).length}) ---`);
  processedLeads.filter(l => !l.isRegistered).slice(0, 10).forEach(l => {
    console.log(`- ${l.name} | ${l.phone} | ${l.city}, ${l.state}`);
  });

  // Write output JSON for report generator
  const outData = {
    generatedAt: new Date().toISOString(),
    totalLeads: processedLeads.length,
    registeredCount,
    remainingCount,
    conversionRate: ((registeredCount / processedLeads.length) * 100).toFixed(1) + "%",
    leads: processedLeads
  };

  fs.writeFileSync(
    path.join(process.cwd(), "partner_leads_analysis.json"),
    JSON.stringify(outData, null, 2)
  );

  console.log("\nSaved partner_leads_analysis.json");
  await mongoose.disconnect();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
