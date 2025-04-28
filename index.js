import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv, {parse} from 'dotenv';
import bodyParser from "body-parser";
import fs from 'fs';

import { logMessage } from "./logger/logger.js";
import { encryptText, decryptText, generateCryptoKeyAndIV } from "./services/crypto.js";

import './global.js'

const envPath = path.join(process.cwd(), '.env');
dotenv.config({ path: envPath });

const BASE_URL = "/qg_webhook/";

const PORT = 4213;

const app = express();
app.use(cors({
    origin: "*"
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

app.post(BASE_URL + "init/", async (req, res) => {
    try {
        const bxLink = req.body.bx_link;
        if (!bxLink) {
            res.status(400).json({
                "status": false,
                "status_msg": "error",
                "message": "Необходимо предоставить ссылку входящего вебхука!"
            });
            return;
        }

        const keyIv = generateCryptoKeyAndIV();
        const bxLinkEncrypted = await encryptText(bxLink, keyIv.CRYPTO_KEY, keyIv.CRYPTO_IV);

        const bxLinkEncryptedBase64 = Buffer.from(bxLinkEncrypted, 'hex').toString('base64');

        const envPath = path.resolve(process.cwd(), '.env');
        const envContent = `CRYPTO_KEY=${keyIv.CRYPTO_KEY}\nCRYPTO_IV=${keyIv.CRYPTO_IV}\nBX_LINK=${bxLinkEncryptedBase64}\n`;

        fs.writeFileSync(envPath, envContent, 'utf8');

        res.status(200).json({
            "status": true,
            "status_msg": "success",
            "message": "Система готова работать с вашим битриксом!",
        });
    } catch (error) {
        logMessage(LOG_TYPES.E, BASE_URL + "/init", error);
        res.status(500).json({
            "status": false,
            "status_msg": "error",
            "message": "Server error"
        });
    }
});

// Обработчик списания бонусов
// Обработчик списания бонусов
app.post(BASE_URL + "bonus_deduct/:ID", async (req, res) => {
    try {
        const dealId = req.body.dealId || req.params.ID || req.query.ID;
        let resultMessage = [];
        if (!dealId) {
            return res.status(400).json({
                "status": false,
                "status_msg": "error",
                "message": "Необходимо предоставить dealId!"
            });
        }

        // Расшифровка URL вебхука
        const encryptedBxLink = process.env.BX_LINK;
        const key = process.env.CRYPTO_KEY;
        const iv = process.env.CRYPTO_IV;

        const baseUrl = await decryptText(encryptedBxLink, key, iv);

        // Получение сделки
        const dealResponse = await fetch(`${baseUrl}crm.deal.get?id=${dealId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
        });
        const deal = await dealResponse.json();
        if (!deal.result) throw new Error('Сделка не найдена');

        // Получение суммы бонусов из поля UF_CRM_1686472442416
        let totalBonuses = parseFloat(deal.result.UF_CRM_1686472442416) || 0;
        if (totalBonuses <= 0) throw new Error('Сумма бонусов некорректна');

        // Получение товарных позиций
        const productRowsResponse = await fetch(`${baseUrl}crm.deal.productrows.get?id=${dealId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
        });
        const productRows = await productRowsResponse.json();
        if (!productRows.result.length) throw new Error('Товары не найдены');

        // Получение данных о товарах и смарт-процессах
        const smartProcessData = await getSmartProcessData(baseUrl);
        const products = await Promise.all(productRows.result.map(async (row) => {
            const productResponse = await fetch(`${baseUrl}catalog.product.get?id=${row.PRODUCT_ID}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
            });
            const product = (await productResponse.json()).result.product;
            const productId = row.PRODUCT_ID;
            return {
                id: product.id,
                productId: productId,
                name: product.name,
                price: parseFloat(row.PRICE_NETTO),
                discount: row.DISCOUNT_SUM,
                quantity: parseFloat(row.QUANTITY),
                totalItemPrice: parseFloat(row.PRICE_NETTO) * parseFloat(row.QUANTITY),
                noBonuses: smartProcessData.noBonusProductIds.includes(productId.toString()) || smartProcessData.noBonusProductIds.includes(product.parentId?.value?.toString()),
                maxDiscountPercent: smartProcessData.maxDiscountProductIds.includes(productId.toString()) || smartProcessData.maxDiscountProductIds.includes(product?.parentId?.value?.toString())
                    ? smartProcessData.maxDiscountPercent
                    : 0.15,
            };
        }));

        // Фильтрация товаров, на которые можно применить бонусы
        const eligibleProducts = products.filter(p => !p.noBonuses);
        if (!eligibleProducts.length) throw new Error('Нет товаров для применения бонусов');

        // Подготовка товаров с максимальной скидкой
        const updatedRows = products.map(product => {
            const maxDiscountPercent = product.maxDiscountPercent || 0.15; // 15% по умолчанию
            return {
                ...product,
                discount: product.discount, // Начальная скидка
                maxDiscount: product.noBonuses ? 0 : product.totalItemPrice * maxDiscountPercent, // Максимальная скидка (по проценту)
                maxPossibleDiscount: product.noBonuses ? 0 : product.totalItemPrice, // Ограничение по стоимости товара
                maxDiscountPercent: maxDiscountPercent,
            };
        });

        let remainingBonuses = totalBonuses;
        let eligibleRows = updatedRows.filter(p => !p.noBonuses);

        // Итеративное распределение бонусов пропорционально максимальной скидке
        while (remainingBonuses > 0 && eligibleRows.length > 0) {
            // Вычисляем общую максимальную скидку для оставшихся товаров
            const totalMaxDiscount = eligibleRows.reduce((sum, product) => {
                const remainingCapacity = Math.min(
                    product.maxDiscount - product.discount,
                    product.maxPossibleDiscount - product.discount
                );
                return sum + (remainingCapacity > 0 ? remainingCapacity : 0);
            }, 0);

            if (totalMaxDiscount <= 0) break; // Если больше нельзя распределить скидки, выходим

            // Сколько бонусов распределить в этом раунде
            const bonusesToDistribute = Math.min(remainingBonuses, totalMaxDiscount);
            let bonusesDistributedThisRound = 0;

            // Пропорциональное распределение
            for (let product of eligibleRows) {
                const remainingCapacity = Math.min(
                    product.maxDiscount - product.discount,
                    product.maxPossibleDiscount - product.discount
                );
                if (remainingCapacity <= 0) continue;

                // Пропорция на основе оставшейся максимальной скидки
                const proportion = remainingCapacity / totalMaxDiscount;
                const discountToAdd = bonusesToDistribute * proportion;

                // Добавляем скидку
                if (discountToAdd < 0.01) continue; // Пропускаем слишком малые значения

                product.discount += discountToAdd;
                remainingBonuses -= discountToAdd;
                bonusesDistributedThisRound += discountToAdd;
            }

            // Обновляем список товаров, которые еще могут принять скидку
            eligibleRows = eligibleRows.filter(p => {
                const remainingCapacity = Math.min(
                    p.maxDiscount - p.discount,
                    p.maxPossibleDiscount - p.discount
                );
                return remainingCapacity > 0;
            });

            // Если в этом раунде не удалось распределить бонусы, прерываем цикл
            if (bonusesDistributedThisRound < 0.01) break;
        }

        console.log(updatedRows);
        console.log("#################");

        // Формируем обновленные товарные позиции
        const finalRows = updatedRows.map(product => {
            const discountPerUnit = Math.round(product.discount / product.quantity); // Округляем скидку за единицу
            resultMessage.push(`${product.id} ${product.name} - ${discountPerUnit}\n`);
            return {
                PRODUCT_ID: product.id,
                PRICE: product.price - discountPerUnit, // Отнимаем скидку от цены за единицу
                QUANTITY: product.quantity,
                DISCOUNT_TYPE_ID: 1,
                DISCOUNT_SUM: discountPerUnit, // Скидка за единицу товара
            };
        });

        // Корректировка общей суммы скидок, чтобы она точно соответствовала totalBonuses
        let totalDiscountSum = finalRows.reduce((sum, row) => sum + (row.DISCOUNT_SUM * row.QUANTITY), 0);
        if (totalDiscountSum !== totalBonuses && finalRows.length > 0) {
            const diff = totalBonuses - totalDiscountSum;
            const lastRow = finalRows[finalRows.length - 1];
            const additionalDiscount = Math.round(diff / lastRow.QUANTITY); // Сколько нужно добавить/убрать за единицу
            lastRow.DISCOUNT_SUM += additionalDiscount; // Корректируем скидку
            lastRow.PRICE -= additionalDiscount; // Корректируем цену соответственно

            // Проверяем итоговую сумму после корректировки
            totalDiscountSum = finalRows.reduce((sum, row) => sum + (row.DISCOUNT_SUM * row.QUANTITY), 0);
            if (totalDiscountSum !== totalBonuses) {
                const finalDiff = totalBonuses - totalDiscountSum;
                lastRow.DISCOUNT_SUM += Math.sign(finalDiff); // Добавляем или вычитаем единицу
                lastRow.PRICE -= Math.sign(finalDiff); // Корректируем цену
            }
        }

        console.log(finalRows);

        // Обновление товарных позиций
        await fetch(`${baseUrl}crm.deal.productrows.set`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: dealId,
                rows: finalRows,
            }),
        });

        // Обновление поля UF_CRM_1744097917673
        await fetch(`${baseUrl}crm.deal.update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: dealId,
                fields: {
                    "UF_CRM_1744097917673": resultMessage
                },
            }),
        });

        res.status(200).json({
            "status": true,
            "status_msg": "success",
            "message": "Бонусы успешно списаны",
        });
    } catch (error) {
        logMessage(LOG_TYPES.E, BASE_URL + "/bonus_deduct", error);
        res.status(500).json({
            "status": false,
            "status_msg": "error",
            "message": "Server error"
        });
    }
});

// Эндпоинт для подсчета суммы сделки (OPPORTUNITY) по товарным позициям
app.post(BASE_URL + "calculate_opportunity/:ID", async (req, res) => {
    try {
        const dealId = req.body.dealId || req.params.ID || req.query.ID;
        if (!dealId) {
            return res.status(400).json({
                "status": false,
                "status_msg": "error",
                "message": "Необходимо предоставить dealId!"
            });
        }

        // Расшифровка URL вебхука
        const encryptedBxLink = process.env.BX_LINK;
        const key = process.env.CRYPTO_KEY;
        const iv = process.env.CRYPTO_IV;

        const baseUrl = await decryptText(encryptedBxLink, key, iv);

        // Получение товарных позиций
        const productRowsResponse = await fetch(`${baseUrl}crm.deal.productrows.get?id=${dealId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
        });
        const productRows = await productRowsResponse.json();
        if (!productRows.result.length) throw new Error('Товары не найдены');

        // Подсчет суммы сделки (OPPORTUNITY)
        const opportunity = productRows.result.reduce((sum, row) => {
            const price = parseFloat(row.PRICE) || 0; // Цена за единицу
            const quantity = parseFloat(row.QUANTITY) || 0; // Количество
            const discount = parseFloat(row.DISCOUNT_SUM) || 0; // Скидка за единицу
            return sum + (price * quantity - discount * quantity); // Итоговая сумма с учетом скидки
        }, 0);

        res.status(200).json({
            "status": true,
            "status_msg": "success",
            "message": "Сумма сделки успешно подсчитана",
            "opportunity": opportunity,
        });
    } catch (error) {
        logMessage(LOG_TYPES.E, BASE_URL + "/calculate_opportunity", error);
        res.status(500).json({
            "status": false,
            "status_msg": "error",
            "message": "Server error"
        });
    }
});

// Получение данных из смарт-процессов
async function getSmartProcessData(baseUrl) {
    // Получение сделки "Товары без бонусов" из смарт-процесса "Скидочная система" (ID 161, сделка ID 4)
    const noBonusDealResponse = await fetch(`${baseUrl}crm.item.get?entityTypeId=161&id=4`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
    });
    const noBonusDeal = await noBonusDealResponse.json();
    const noBonusProductIds = noBonusDeal.result?.item?.ufCrm6_1745296707776 || [];

    // Получение сделки "Группа: списание 50% / начисление 50%" из смарт-процесса "Макс. списания/начисления бонусов" (ID 1044, сделка ID 8)
    const maxDiscountDealResponse = await fetch(`${baseUrl}crm.item.get?entityTypeId=1044&id=8`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
    });
    const maxDiscountDeal = await maxDiscountDealResponse.json();
    const maxDiscountPercent = parseFloat(maxDiscountDeal.result?.item?.ufCrm12_1744002374) / 100 || null;
    const maxDiscountProductIds = maxDiscountDeal.result?.item?.ufCrm12_1744639109 || [];

    return {
        noBonusProductIds: noBonusProductIds,
        maxDiscountPercent: maxDiscountPercent,
        maxDiscountProductIds: maxDiscountProductIds,
    };
}

app.listen(PORT, () => {
    console.log(`App is running on port ${PORT}`);
});