import { PrismaClient } from "../../generated/prisma";
import { GoogleGenAI } from '@google/genai';

const prisma = new PrismaClient();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY as string;

const ai = GEMINI_API_KEY ? new GoogleGenAI({ 
    apiKey: GEMINI_API_KEY 
}) : null; 
// อาจเกิดGemini API 503 Overloaded ได้ถ้าการใช้งานมากเกินไป
const model = "gemini-2.5-pro";

// Helper: ชื่อเดือนภาษาไทยสำหรับกราฟ
const thaiMonths = [
    'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
    'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'
];

function getBookId<T extends { bookId: any }>(item: T): T['bookId'] {
    return item.bookId;
}

export const DashboardController = {
    list: async ({ 
        query,
        set 
    }: {
        query: {
            month?: string,
            year?: string,
            category?: string
        },
        set: {
            status: number
        }
    }) => {
        try {
            // --- 1. การดึงข้อมูลสรุปหลักแบบขนาน (Summary Card) ---
            const [
                totalOrder, 
                totalMember, 
                totalIncomeResult, 
                totalSaleCount, 
                totalSaleIncomeResult,
                categories
            ] = await Promise.all([
                prisma.order.count(),
                prisma.member.count(),
                prisma.orderDetail.aggregate({
                    _sum: { price: true },
                    where: { Order: { status: { not: 'cancel' } } }
                }),
                prisma.sale.count(),
                prisma.sale.aggregate({
                    _sum: { total: true }
                }),
                prisma.book.findMany({
                    select: { category: true },
                    distinct: ['category'],
                    where: { category: { not: null } }
                })
            ]);

            const totalIncome = totalIncomeResult._sum.price || 0;
            const totalSaleIncome = totalSaleIncomeResult._sum.total || 0;
            const totalAllIncome = totalIncome + totalSaleIncome;
            const uniqueCategories = categories
                .map(item => item.category)
                .filter((category): category is string => category !== null);

            // --- 2. การเตรียม Filter และการดึงข้อมูลกราฟแบบขนาน ---
            const currentDate = new Date();
            const selectedYear = query.year ? parseInt(query.year) : currentDate.getFullYear();
            const selectedMonth = query.month ? parseInt(query.month) : null;
            const selectedCategory = query.category || null;

            const monthlyIncome = [];
            
            if (selectedMonth) {
                // แสดงรายได้รายวันในเดือนที่เลือก (Daily View)
                const endDate = new Date(selectedYear, selectedMonth, 0); 
                const daysInMonth = endDate.getDate();
                
                const dailyPromises = [];

                for (let day = 1; day <= daysInMonth; day++) {
                    const dayStart = new Date(selectedYear, selectedMonth - 1, day);
                    const dayEnd = new Date(selectedYear, selectedMonth - 1, day + 1); 
                    
                    // 2.1 รายได้ออนไลน์ 
                    const onlinePromise = prisma.orderDetail.aggregate({
                        _sum: { price: true },
                        where: {
                            Order: { status: { not: 'cancel' }, createdAt: { gte: dayStart, lt: dayEnd } },
                            ...(selectedCategory && { Book: { category: selectedCategory } })
                        }
                    });

                    // 2.2 รายได้หน้าร้าน (แก้ไขปัญหา 1: เปลี่ยน Book เป็น book)
                    const salePromise = prisma.sale.aggregate({
                        _sum: { total: true },
                        where: { 
                            createdAt: { gte: dayStart, lt: dayEnd },
                            ...(selectedCategory && { 
                                details: { 
                                    some: {
                                        book: { // <-- แก้ไขตรงนี้: ใช้ 'book' ตัวพิมพ์เล็ก
                                            category: selectedCategory
                                        }
                                    }
                                }
                            })
                        }
                    });

                    dailyPromises.push(Promise.all([onlinePromise, salePromise, day]));
                }
                
                const results = await Promise.all(dailyPromises);

                for (const [dailyOnlineIncomeResult, dailySaleIncomeResult, day] of results) {
                    // แก้ไขปัญหา 2: ใช้ ! เพื่อบอก TypeScript ว่า _sum จะมีอยู่เสมอ (ถึงแม้ค่าข้างในจะเป็น null)
                    const onlineIncome = dailyOnlineIncomeResult._sum!.price || 0; 
                    const saleIncome = dailySaleIncomeResult._sum!.total || 0; // <-- แก้ไขตรงนี้

                    monthlyIncome.push({
                        month: `${day}`,
                        onlineIncome: onlineIncome,
                        saleIncome: saleIncome,
                        income: onlineIncome + saleIncome,
                        year: selectedYear
                    });
                }

            } else {
                // แสดงรายได้รายเดือนในปีที่เลือก (Monthly View)
                const monthlyPromises = [];

                for (let month = 0; month < 12; month++) {
                    const startDate = new Date(selectedYear, month, 1);
                    const endDate = new Date(selectedYear, month + 1, 1);
                    
                    // 2.3 รายได้ออนไลน์
                    const onlinePromise = prisma.orderDetail.aggregate({
                        _sum: { price: true },
                        where: {
                            Order: { status: { not: 'cancel' }, createdAt: { gte: startDate, lt: endDate } },
                            ...(selectedCategory && { Book: { category: selectedCategory } })
                        }
                    });

                    // 2.4 รายได้หน้าร้าน (แก้ไขปัญหา 1: เปลี่ยน Book เป็น book)
                    const salePromise = prisma.sale.aggregate({
                        _sum: { total: true },
                        where: { 
                            createdAt: { gte: startDate, lt: endDate },
                            ...(selectedCategory && { 
                                details: {
                                    some: {
                                        book: { // <-- แก้ไขตรงนี้: ใช้ 'book' ตัวพิมพ์เล็ก
                                            category: selectedCategory
                                        }
                                    }
                                }
                            })
                        }
                    });

                    monthlyPromises.push(Promise.all([onlinePromise, salePromise, month]));
                }
                
                const results = await Promise.all(monthlyPromises);

                for (const [monthlyOnlineIncomeResult, monthlySaleIncomeResult, month] of results) {
                    // แก้ไขปัญหา 3: ใช้ ! เพื่อบอก TypeScript ว่า _sum จะมีอยู่เสมอ (ถึงแม้ค่าข้างในจะเป็น null)
                    const onlineIncome = monthlyOnlineIncomeResult._sum!.price || 0;
                    const saleIncome = monthlySaleIncomeResult._sum!.total || 0; // <-- แก้ไขตรงนี้

                    monthlyIncome.push({
                        month: thaiMonths[month],
                        onlineIncome: onlineIncome,
                        saleIncome: saleIncome,
                        income: onlineIncome + saleIncome,
                        year: selectedYear
                    });
                }
            }

            // --- 3. ดึงข้อมูลสินค้าขายดี (Top Products) ---
            const [topProductsOnline, topProductsSale] = await Promise.all([
                prisma.orderDetail.groupBy({
                    by: ['bookId'],
                    _sum: { qty: true, price: true },
                    where: { Order: { status: { not: 'cancel' } } }
                }),
                prisma.saleDetail.groupBy({
                    by: ['bookId'],
                    _sum: { qty: true, price: true }
                })
            ]);
            
            // ... (ส่วนการรวมและดึงรายละเอียดหนังสือ)
            const combinedProducts = new Map<typeof topProductsOnline[0]['bookId'], { 
                bookId: typeof topProductsOnline[0]['bookId'], 
                totalQty: number, 
                totalRevenue: number 
            }>();

            topProductsOnline.forEach(item => {
                combinedProducts.set(item.bookId, { bookId: item.bookId, totalQty: item._sum.qty || 0, totalRevenue: item._sum.price || 0 });
            });

            topProductsSale.forEach(item => {
                const existing = combinedProducts.get(item.bookId);
                if (existing) {
                    existing.totalQty += item._sum.qty || 0;
                    existing.totalRevenue += item._sum.price || 0;
                } else {
                    combinedProducts.set(item.bookId, { bookId: item.bookId, totalQty: item._sum.qty || 0, totalRevenue: item._sum.price || 0 });
                }
            });

            const topProducts = Array.from(combinedProducts.values())
                .sort((a, b) => b.totalQty - a.totalQty)
                .slice(0, 5);

            const bookIds = topProducts.map(p => p.bookId);
            
            const booksDetails = await prisma.book.findMany({
                where: { 
                    id: { in: bookIds as any } 
                }, 
                select: { id: true, name: true, image: true, category: true, price: true }
            });

            const topProductsWithDetails = topProducts.map(product => {
                const book = booksDetails.find(b => b.id === product.bookId);
                
                return {
                    id: product.bookId, 
                    name: book?.name || '',
                    image: book?.image || null,
                    category: book?.category || '',
                    price: book?.price || 0,
                    totalSold: product.totalQty,
                    totalRevenue: product.totalRevenue
                };
            });
            
            // --- 4. Return Final Response ---
            return {
                totalOrder: totalOrder,
                totalIncome: totalIncome,
                totalSaleCount: totalSaleCount,
                totalSaleIncome: totalSaleIncome,
                totalAllIncome: totalAllIncome,
                totalMember: totalMember,
                monthlyIncome: monthlyIncome,
                topProducts: topProductsWithDetails,
                categories: uniqueCategories,
                selectedFilters: {
                    month: selectedMonth,
                    year: selectedYear,
                    category: selectedCategory
                }
            }
        } catch (err) {
            console.error('Dashboard error:', err);
            set.status = 500;
            return { error: 'Internal server error' };
        }
    },

    analyze: async ({ 
        body,
        set 
    }: {
        body: any, // รับ Body เข้ามาแบบไม่มี Type
        set: { status: number }
    }) => {
        try {
            if (!ai) {
                set.status = 500;
                return { error: 'Gemini API Key is not configured on the server.' };
            }

            // ** Type Assertion: บังคับให้ TypeScript ยอมรับโครงสร้าง (as any) **
            const dashboardData = body as any; 
            
            // --- สร้าง Prompt ที่มีประสิทธิภาพ ---
            const totalRevenue = dashboardData.totalAllIncome || 0;
            
            // ต้องระบุ Type (any) ใน Loop/Map ด้วย
            const topBooksSummary = dashboardData.topProducts 
                ? dashboardData.topProducts.map((b: any) => `${b.name} (ขาย ${b.totalSold} ชิ้น, รายได้ ${b.totalRevenue.toLocaleString()} บาท)`).join('; ') 
                : 'ไม่มีข้อมูลสินค้าขายดี';
                
            const monthlyIncomeSummary = dashboardData.monthlyIncome
                ? JSON.stringify(dashboardData.monthlyIncome.map((m: any) => ({
                    month: m.month,
                    online: m.onlineIncome.toLocaleString(),
                    sale: m.saleIncome.toLocaleString(),
                    total_income: m.income.toLocaleString()
                })))
                : 'ไม่มีข้อมูลรายได้รายเดือน';
                
            const analysisPrompt = `
                คุณคือผู้เชี่ยวชาญด้านการวิเคราะห์ธุรกิจ ช่วยวิเคราะห์ข้อมูลการขายนี้เพื่อหาแนวโน้ม, จุดแข็ง, จุดอ่อน, และให้คำแนะนำเชิงกลยุทธ์ในอนาคต

                **ข้อมูลปัจจุบัน (ทั้งหมดในสกุลเงินบาท):**
                - รายได้รวมทั้งหมด: ${totalRevenue.toLocaleString()} บาท
                - สินค้าขายดี 5 อันดับแรก: ${topBooksSummary}
                - ข้อมูลรายได้รายเดือน/รายวัน: ${monthlyIncomeSummary}

                โปรดเขียนบทวิเคราะห์เป็นภาษาไทยอย่างละเอียดในลักษณะเป็นมืออาชีพ ความยาวประมาณ 4-5 ย่อหน้า โดยเน้นไปที่:
                1. แนวโน้มรายได้ (Revenue Trends) และสุขภาพทางการเงินโดยรวม
                2. การวิเคราะห์สินค้าขายดี (Top Sellers) และโอกาสในการทำ Cross-sell หรือ Up-sell
                3. คำแนะนำเชิงกลยุทธ์สำหรับการเติบโตของยอดขายและผลกำไรในไตรมาสถัดไป
                4. จุดที่น่ากังวลหรือควรปรับปรุง
            `;
            
            // --- เรียกใช้ Gemini API ---
            const response = await ai!.models.generateContent({
                model: model,
                contents: analysisPrompt,
                config: {
                    temperature: 0.5,
                }
            });

            const analysisText = response.text;

            // --- ส่งผลลัพธ์กลับไป Frontend ---
            return { analysis: analysisText };

        } catch (error) {
            console.error('Gemini Analysis Error:', error);
            set.status = 500;
            return { error: `เกิดข้อผิดพลาดในการประมวลผลการวิเคราะห์ด้วย AI: ${(error as Error).message}` };
        }
    },

    getIncomeByDateRange: async ({ 
        startDate, 
        endDate, 
        set 
    }: {
        startDate: string,
        endDate: string,
        set: { status: number }
    }) => {
        try {
            const onlineIncomePromise = prisma.orderDetail.aggregate({
                _sum: { price: true },
                where: {
                    Order: { status: { not: 'cancel' }, createdAt: { gte: new Date(startDate), lte: new Date(endDate) } }
                }
            });

            const saleIncomePromise = prisma.sale.aggregate({
                _sum: { total: true },
                where: { createdAt: { gte: new Date(startDate), lte: new Date(endDate) } }
            });
            
            const [onlineIncome, saleIncome] = await Promise.all([onlineIncomePromise, saleIncomePromise]);

            const totalOnlineIncome = onlineIncome._sum.price || 0;
            const totalSaleIncome = saleIncome._sum.total || 0;

            return {
                onlineIncome: totalOnlineIncome,
                saleIncome: totalSaleIncome,
                totalIncome: totalOnlineIncome + totalSaleIncome,
                startDate,
                endDate
            };
        } catch (err) {
            console.error('Income by date range error:', err);
            set.status = 500;
            return { error: 'Internal server error' };
        }
    },
    
}